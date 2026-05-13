import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { endLiveActivity, pushNotification, updateLiveActivity } from "./activitysmith.js";
import type { SessionRecord } from "./types.js";

interface RunnerOptions {
  /** Where this session lives. We use this as $HOME for pi. */
  sessionDir: string;
  /** Where pi runs (cwd). */
  workspaceDir: string;
  /** Absolute path to the session JSONL file we want pi to resume. */
  sessionFile: string;
  /** Session record (shared/mutated by the runner). */
  record: SessionRecord;
  /** Called when pi exits, with the final state. */
  onExit?: (record: SessionRecord) => void;
}

const DEFAULT_KICKOFF =
  "Proceed with the plan above. Work autonomously without asking clarifying questions. When you finish or hit a blocker you cannot resolve, summarize what you did and stop.";

export class PiRunner {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private logStream: ReturnType<typeof createWriteStream> | null = null;
  private liveActivityTimer: NodeJS.Timeout | null = null;

  constructor(private opts: RunnerOptions) {}

  get record() {
    return this.opts.record;
  }

  async start(): Promise<void> {
    const { sessionDir, workspaceDir, sessionFile, record } = this.opts;

    // Pre-flight: npm install in any extension dir that has a package.json
    // but no node_modules. The shipped bundle excludes node_modules because
    // native bindings would be mac-arm64 in a linux container.
    await this.installExtensionDeps(sessionDir);

    record.startedAt = Date.now();
    record.state = "running";

    const logPath = path.join(sessionDir, "pi.log");
    this.logStream = createWriteStream(logPath, { flags: "a" });

    const env: NodeJS.ProcessEnv = {
      // Keep PATH so pi binary resolves.
      PATH: process.env.PATH,
      // Sandbox pi's view of $HOME to this session's dir.
      // This is where pi will look for ~/.pi/agent/{settings.json,skills,...}.
      HOME: sessionDir,
      // Required so pi-coding-agent's child processes also see HOME.
      USER: "pi",
      // User-supplied provider API keys.
      ...this.opts.record.meta.apiKeys,
      // Don't inherit the server's offload token, AS key, etc.
    };

    this.proc = spawn(
      "pi",
      ["--mode", "rpc", "--session", sessionFile],
      {
        cwd: workspaceDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");

    this.proc.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    this.proc.stderr.on("data", (chunk: string) => {
      this.logStream?.write(`[stderr] ${chunk}`);
    });

    this.proc.on("exit", (code, signal) => this.handleExit(code, signal));
    this.proc.on("error", (err) => {
      record.error = `pi spawn error: ${err.message}`;
      record.state = "error";
      this.logStream?.write(`[error] ${err.message}\n`);
    });

    // Send the kickoff prompt.
    const kickoff = (record.meta.kickoffPrompt?.trim() || DEFAULT_KICKOFF);
    this.send({ type: "prompt", message: kickoff });

    // Notify on Live Activity that we've started.
    await updateLiveActivity({
      sessionId: record.id,
      projectName: record.meta.projectName,
      subtitle: "starting…",
      metrics: this.currentMetrics(),
      actionUrl: this.publicUrl(),
    });
  }

  private publicUrl(): string {
    return `${config.appUrl}/s/${this.record.id}?k=${this.record.viewKey}`;
  }

  async stop(reason: "user" | "shutdown" = "user"): Promise<void> {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
    setTimeout(() => {
      if (this.proc && this.proc.exitCode === null) {
        this.proc.kill("SIGKILL");
      }
    }, 3000);
    if (reason === "user") {
      this.record.state = "stopped";
    }
  }

  /**
   * Ask pi to exit cleanly via the RPC protocol, then wait up to `timeoutMs`
   * before sending SIGKILL. Used by the server's SIGTERM handler so we don't
   * orphan a child mid-write.
   */
  async gracefulExit(timeoutMs = 5000): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    try {
      this.send({ type: "abort" });
      this.send({ type: "exit" });
    } catch {
      /* fall through to SIGTERM */
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGKILL");
        resolve();
      }, timeoutMs);
      proc.once("exit", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      // Trigger a SIGTERM after 1s if it hasn't responded to {type:'exit'}.
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGTERM");
      }, 1000);
    });
  }

  private send(obj: Record<string, unknown>) {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(`${JSON.stringify(obj)}\n`);
    } catch (err) {
      this.logStream?.write(`[stdin write error] ${(err as Error).message}\n`);
    }
  }

  private handleStdout(chunk: string) {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).replace(/\r$/, "");
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      this.logStream?.write(`${line}\n`);
      try {
        const evt = JSON.parse(line);
        void this.handleEvent(evt);
      } catch {
        // Non-JSON output (shouldn't happen in RPC mode, but ignore).
      }
    }
  }

  private async handleEvent(evt: any): Promise<void> {
    switch (evt.type) {
      case "agent_start":
        // Already set startedAt; nothing extra.
        break;

      case "turn_end": {
        this.record.stats.turns += 1;
        const msg = evt.message;
        const usage = msg?.usage;
        if (usage) {
          this.record.stats.tokensIn = usage.input ?? this.record.stats.tokensIn;
          this.record.stats.tokensOut = usage.output ?? this.record.stats.tokensOut;
          this.record.stats.costUsd = usage.cost?.total ?? this.record.stats.costUsd;
        }
        // Extract a short last-message snippet for the subtitle.
        const text = extractAssistantText(msg);
        if (text) {
          this.record.stats.lastMessage = text.slice(0, 120);
        }
        await this.pushLiveActivity("thinking");
        break;
      }

      case "tool_execution_start":
        this.record.stats.lastTool = evt.toolName;
        await this.pushLiveActivity(`tool: ${evt.toolName}`);
        break;

      case "tool_execution_end": {
        if (evt.isError) {
          this.record.stats.errorCount += 1;
          if (config.notifyLevel !== "off") {
            const snippet = extractErrorSnippet(evt.result);
            await pushNotification({
              title: `⚠️ Tool error: ${evt.toolName}`,
              message: snippet || "Tool returned an error.",
              redirectionUrl: this.publicUrl(),
            });
          }
        } else if (config.notifyLevel === "all") {
          await pushNotification({
            title: `✅ ${evt.toolName}`,
            message: this.record.meta.projectName,
          });
        }
        break;
      }

      case "agent_end": {
        this.record.state = "done";
        this.record.endedAt = Date.now();
        await endLiveActivity({
          sessionId: this.record.id,
          projectName: this.record.meta.projectName,
          subtitle: `done · ${this.record.stats.turns} turns · $${this.record.stats.costUsd.toFixed(3)}`,
          metrics: this.currentMetrics(),
        });
        await pushNotification({
          title: `✅ ${this.record.meta.projectName} finished`,
          message: this.record.stats.lastMessage ?? `${this.record.stats.turns} turns, $${this.record.stats.costUsd.toFixed(3)}`,
          redirectionUrl: this.publicUrl(),
        });
        // Exit pi cleanly so /reclaim can fetch the session.
        this.send({ type: "exit" });
        break;
      }

      case "extension_error":
        this.logStream?.write(`[extension_error] ${evt.error}\n`);
        break;

      case "extension_ui_request": {
        // Headless mode: auto-resolve dialogs (cancel = safe-default).
        if (evt.method === "select" || evt.method === "confirm" || evt.method === "input" || evt.method === "editor") {
          this.send({ type: "extension_ui_response", id: evt.id, cancelled: true });
        }
        // Fire-and-forget methods need no response.
        break;
      }
    }
  }

  private async pushLiveActivity(subtitle: string) {
    // Debounce — Live Activity updates are cheap but no need to spam.
    if (this.liveActivityTimer) return;
    this.liveActivityTimer = setTimeout(() => {
      this.liveActivityTimer = null;
    }, 1500);
    await updateLiveActivity({
      sessionId: this.record.id,
      projectName: this.record.meta.projectName,
      subtitle,
      metrics: this.currentMetrics(),
      actionUrl: this.publicUrl(),
    });
  }

  private currentMetrics() {
    const s = this.record.stats;
    return [
      { label: "Turn", value: s.turns },
      { label: "Tok", value: Math.round((s.tokensIn + s.tokensOut) / 1000), unit: "k" },
      { label: "USD", value: Number(s.costUsd.toFixed(2)) },
    ];
  }

  private async handleExit(code: number | null, signal: NodeJS.Signals | null) {
    this.logStream?.write(`[exit] code=${code} signal=${signal}\n`);
    this.logStream?.end();
    this.logStream = null;

    if (this.record.state === "running") {
      // Process died without an agent_end event.
      this.record.state = code === 0 ? "done" : "error";
      this.record.endedAt = Date.now();
      if (this.record.state === "error") {
        this.record.error = `pi exited with code ${code} signal ${signal}`;
        await pushNotification({
          title: `🔴 ${this.record.meta.projectName} crashed`,
          message: this.record.error,
          redirectionUrl: this.publicUrl(),
        });
        await endLiveActivity({
          sessionId: this.record.id,
          projectName: this.record.meta.projectName,
          subtitle: "crashed",
          metrics: this.currentMetrics(),
        });
      }
    }

    this.opts.onExit?.(this.record);
  }

  private async installExtensionDeps(sessionDir: string) {
    const extDir = path.join(sessionDir, ".pi", "agent", "extensions");
    let entries: string[];
    try {
      entries = await fs.readdir(extDir);
    } catch {
      return; // no extensions
    }

    for (const name of entries) {
      const full = path.join(extDir, name);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      const pkg = path.join(full, "package.json");
      try {
        await fs.access(pkg);
      } catch {
        continue;
      }

      const nm = path.join(full, "node_modules");
      try {
        await fs.access(nm);
        continue; // already installed
      } catch {
        // need install
      }

      this.logStream?.write(`[npm install] ${full}\n`);
      await new Promise<void>((resolve) => {
        const p = spawn("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
          cwd: full,
          stdio: "pipe",
        });
        p.on("exit", () => resolve());
        p.on("error", () => resolve());
      });
    }
  }
}

function extractAssistantText(message: any): string | null {
  if (!message || message.role !== "assistant") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ").trim() : null;
}

function extractErrorSnippet(result: any): string | null {
  if (!result?.content) return null;
  const text = result.content.find((c: any) => c.type === "text")?.text;
  if (!text) return null;
  return text.slice(0, 200);
}
