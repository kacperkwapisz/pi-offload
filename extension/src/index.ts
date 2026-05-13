import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { bundlePiConfig, bundleWorkspace, collectApiKeys, extractTarGzTo } from "./bundle.js";
import { OffloadClient } from "./client.js";
import { configPath, readConfig, writeConfig } from "./config.js";
import { clearSentinel, writeSentinel } from "./sentinel.js";
import { clearState, readState, writeState } from "./state.js";

const ALLOWED_LOCKED_COMMANDS = new Set([
  "/reclaim",
  "/offload-status",
  "/offload-force-unlock",
]);

function fmtAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function (pi: ExtensionAPI) {
  // -----------------------------------------------------------------------
  // Lock enforcement (primary): block input while project is offloaded.
  // -----------------------------------------------------------------------
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const state = await readState(ctx.cwd);
    if (!state) return { action: "continue" };

    const trimmed = event.text.trim();
    const firstWord = trimmed.split(/\s+/, 1)[0] ?? "";
    if (ALLOWED_LOCKED_COMMANDS.has(firstWord)) {
      return { action: "continue" };
    }

    ctx.ui.notify(
      `🔒 Offloaded to ${state.serverUrl} (id: ${state.id}, ${fmtAgo(state.startedAt)}). ` +
        `Run /reclaim to pull it back, /offload-status to peek, or /offload-force-unlock to clear the lock.`,
      "warning",
    );
    return { action: "handled" };
  });

  // -----------------------------------------------------------------------
  // /offload
  // -----------------------------------------------------------------------
  pi.registerCommand("offload", {
    description: "Offload the current session to the remote VPS and shut down local pi.",
    handler: async (_args, ctx) => {
      const cfg = await readConfig();
      if (!cfg) {
        ctx.ui.notify(
          `No offload config found. Create ${configPath()} with { serverUrl, token }.`,
          "error",
        );
        return;
      }

      if (await readState(ctx.cwd)) {
        ctx.ui.notify("This project is already offloaded. Run /reclaim first.", "warning");
        return;
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Current session has no file (ephemeral mode). Cannot offload.", "error");
        return;
      }

      await ctx.waitForIdle();

      // Stage bundles to a temp directory so we can stream them to the server.
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-offload-"));
      const workspaceTar = path.join(tmpDir, "workspace.tar.gz");
      const piConfigTar = path.join(tmpDir, "pi-config.tar.gz");

      ctx.ui.notify("Bundling workspace and config…", "info");
      try {
        await Promise.all([
          bundleWorkspace(ctx.cwd, workspaceTar),
          bundlePiConfig(cfg.excludeExtensions ?? [], piConfigTar),
        ]);
      } catch (err) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        ctx.ui.notify(`Bundle failed: ${(err as Error).message}`, "error");
        return;
      }

      const projectName = path.basename(ctx.cwd);
      const client = new OffloadClient(cfg.serverUrl, cfg.token);

      let created: Awaited<ReturnType<typeof client.createSession>>;
      try {
        created = await client.createSession({
          projectName,
          originalCwd: ctx.cwd,
          kickoffPrompt: cfg.kickoffPrompt,
          apiKeys: collectApiKeys(),
        });
      } catch (err) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        ctx.ui.notify(`Create failed: ${(err as Error).message}`, "error");
        return;
      }

      ctx.ui.notify(`Uploading (session ${created.id})…`, "info");
      try {
        // Sequential uploads — keeps memory flat and simplifies error reporting.
        await client.uploadFile(created.upload.workspace, workspaceTar, "application/gzip");
        await client.uploadFile(created.upload.piConfig, piConfigTar, "application/gzip");
        await client.uploadFile(created.upload.session, sessionFile, "application/x-ndjson");
      } catch (err) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        ctx.ui.notify(`Upload failed: ${(err as Error).message}`, "error");
        // Best-effort cleanup on the server.
        try {
          await client.delete(created.id);
        } catch {
          /* ignore */
        }
        return;
      }

      await fs.rm(tmpDir, { recursive: true, force: true });

      ctx.ui.notify("Starting remote agent…", "info");
      try {
        await client.start(created.id);
      } catch (err) {
        ctx.ui.notify(`Start failed: ${(err as Error).message}`, "error");
        return;
      }

      // Write both layers of lock state.
      await writeState({
        id: created.id,
        serverUrl: cfg.serverUrl,
        startedAt: Date.now(),
        projectPath: ctx.cwd,
        projectName,
      });
      await writeSentinel({
        cwd: ctx.cwd,
        sessionId: created.id,
        serverUrl: cfg.serverUrl,
      });

      ctx.ui.notify(
        `🚀 Offloaded as ${created.id}. Closing local pi — you'll see progress on your iPhone. Run /reclaim later.`,
        "info",
      );
      ctx.shutdown();
    },
  });

  // -----------------------------------------------------------------------
  // /offload-status
  // -----------------------------------------------------------------------
  pi.registerCommand("offload-status", {
    description: "Show the status of the offloaded session for this project.",
    handler: async (_args, ctx) => {
      const cfg = await readConfig();
      const state = await readState(ctx.cwd);
      if (!state) {
        ctx.ui.notify("This project is not currently offloaded.", "info");
        return;
      }
      if (!cfg) {
        ctx.ui.notify(`Lock exists for id ${state.id} but offload-config.json is missing.`, "warning");
        return;
      }

      const client = new OffloadClient(cfg.serverUrl, cfg.token);
      try {
        const status = await client.status(state.id);
        const s = status.stats ?? {};
        ctx.ui.notify(
          `[${status.state}] ${status.meta?.projectName ?? state.projectName} · ` +
            `turns ${s.turns ?? 0} · tok ${(s.tokensIn ?? 0) + (s.tokensOut ?? 0)} · ` +
            `$${(s.costUsd ?? 0).toFixed(3)}` +
            (s.lastTool ? ` · last: ${s.lastTool}` : "") +
            (status.error ? ` · err: ${status.error}` : ""),
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`Status fetch failed: ${(err as Error).message}`, "error");
      }
    },
  });

  // -----------------------------------------------------------------------
  // /reclaim
  // -----------------------------------------------------------------------
  pi.registerCommand("reclaim", {
    description: "Pull the offloaded session and workspace back from the VPS and unlock the project.",
    handler: async (args, ctx) => {
      const force = args.trim() === "--force";
      const cfg = await readConfig();
      if (!cfg) {
        ctx.ui.notify(`Missing ${configPath()}.`, "error");
        return;
      }
      const state = await readState(ctx.cwd);
      if (!state) {
        ctx.ui.notify("This project is not currently offloaded.", "info");
        return;
      }

      const client = new OffloadClient(cfg.serverUrl, cfg.token);
      let status: any;
      try {
        status = await client.status(state.id);
      } catch (err) {
        ctx.ui.notify(`Status fetch failed: ${(err as Error).message}`, "error");
        return;
      }

      if (status.state === "running" && !force) {
        ctx.ui.notify(
          "Remote is still running. Use /reclaim --force to stop and pull anyway.",
          "warning",
        );
        return;
      }

      if (status.state === "running" && force) {
        try {
          await client.stop(state.id);
        } catch (err) {
          ctx.ui.notify(`Stop failed: ${(err as Error).message}`, "error");
          return;
        }
      }

      ctx.ui.notify("Downloading workspace and session…", "info");
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-offload-reclaim-"));
      const wsTar = path.join(tmpDir, "workspace.tar.gz");
      const sessionFile = ctx.sessionManager.getSessionFile();

      try {
        await client.downloadWorkspaceTarGz(state.id, wsTar);
        if (sessionFile) await client.downloadSessionJsonl(state.id, sessionFile);
      } catch (err) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        ctx.ui.notify(`Download failed: ${(err as Error).message}`, "error");
        return;
      }

      ctx.ui.notify("Extracting workspace (overwriting local files)…", "info");
      try {
        await extractTarGzTo(wsTar, ctx.cwd);
      } catch (err) {
        await fs.rm(tmpDir, { recursive: true, force: true });
        ctx.ui.notify(`Extract failed: ${(err as Error).message}`, "error");
        return;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });

      try {
        await client.delete(state.id);
      } catch {
        /* best-effort */
      }

      await clearState(ctx.cwd);
      await clearSentinel(ctx.cwd);

      ctx.ui.notify(
        sessionFile
          ? `✅ Reclaimed. Session updated at ${sessionFile}. Restart pi (or /resume) to load it.`
          : `✅ Workspace reclaimed. (No local session file to update.)`,
        "info",
      );
    },
  });

  // -----------------------------------------------------------------------
  // /offload-setup — interactive config wizard.
  // -----------------------------------------------------------------------
  pi.registerCommand("offload-setup", {
    description: "Configure pi-offload (server URL + bearer token).",
    handler: async (_args, ctx) => {
      const existing = await readConfig();
      const serverUrl = await ctx.ui.input(
        "pi-offload server URL",
        existing?.serverUrl ?? "https://pi-offload.yourdomain.com",
      );
      if (!serverUrl) return;

      const token = await ctx.ui.input(
        "OFFLOAD_TOKEN (matches the server's env)",
        existing?.token ?? "",
      );
      if (!token) return;

      // Quick connectivity probe.
      let healthOk = false;
      try {
        const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/health`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        healthOk = res.ok;
      } catch {
        /* network error */
      }

      if (!healthOk) {
        const cont = await ctx.ui.confirm(
          "Health check failed",
          `Could not reach ${serverUrl}/health. Save the config anyway?`,
        );
        if (!cont) return;
      }

      await writeConfig({
        serverUrl: serverUrl.replace(/\/+$/, ""),
        token,
        excludeExtensions: existing?.excludeExtensions ?? [],
        kickoffPrompt: existing?.kickoffPrompt,
      });

      ctx.ui.notify(
        healthOk
          ? `✅ Config saved to ${configPath()} and server is reachable.`
          : `⚠️  Config saved to ${configPath()} (server unreachable — fix and retry).`,
        healthOk ? "info" : "warning",
      );
    },
  });

  // -----------------------------------------------------------------------
  // /offload-force-unlock
  // -----------------------------------------------------------------------
  pi.registerCommand("offload-force-unlock", {
    description: "Clear the offload lock for this project WITHOUT pulling state back. Use if the remote is unreachable.",
    handler: async (_args, ctx) => {
      const state = await readState(ctx.cwd);
      if (!state) {
        ctx.ui.notify("No lock found for this project.", "info");
        return;
      }
      const ok = await ctx.ui.confirm(
        "Force unlock?",
        `This will clear the lock for ${state.projectName} (id ${state.id}) WITHOUT pulling remote state back. Any work done on the VPS will be left there. Continue?`,
      );
      if (!ok) return;
      await clearState(ctx.cwd);
      await clearSentinel(ctx.cwd);
      ctx.ui.notify("Lock cleared. Remote session (if any) is still on the VPS — manage via the server API.", "info");
    },
  });
}
