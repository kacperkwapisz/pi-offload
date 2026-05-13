import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Run `tar` and stream its gzipped output directly to a file on disk
 * (no buffering in memory).
 *
 * If `stdinFileList` is provided, it's written to tar's stdin. The list MUST
 * be NUL-separated when paired with the tar `--null` flag.
 */
function runTarToFile(args: string[], outPath: string, stdinFileList?: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = createWriteStream(outPath);
    const proc = spawn("tar", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stdout.pipe(ws);
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("error", reject);
    ws.on("error", reject);
    proc.on("exit", (code) => {
      ws.end(() => {
        if (code === 0) resolve();
        else reject(new Error(`tar exited ${code}: ${stderr}`));
      });
    });
    if (stdinFileList !== undefined) {
      proc.stdin.end(stdinFileList);
    } else {
      proc.stdin.end();
    }
  });
}

async function isGitRepo(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore",
    });
    p.on("exit", (c) => resolve(c === 0));
    p.on("error", () => resolve(false));
  });
}

/**
 * Bundle the workspace into a tar.gz file at `outPath`.
 *
 * Strategy:
 *  - If `cwd` is a git repo, use `git ls-files -coz --exclude-standard` to
 *    honour .gitignore exactly and stay safe against pathnames with newlines.
 *  - Otherwise fall back to tarring everything except a small junk list.
 *
 * Always excludes `.git/` regardless.
 */
export async function bundleWorkspace(cwd: string, outPath: string): Promise<void> {
  if (await isGitRepo(cwd)) {
    const fileList = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(
        "git",
        ["-C", cwd, "ls-files", "-coz", "--exclude-standard"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const chunks: Buffer[] = [];
      let err = "";
      p.stdout.on("data", (c: Buffer) => chunks.push(c));
      p.stderr.on("data", (c: Buffer) => (err += c.toString()));
      p.on("error", reject);
      p.on("exit", (code) =>
        code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git ls-files failed: ${err}`)),
      );
    });
    // --null pairs with `git ls-files -z` for NUL-separated paths.
    await runTarToFile(["-czf", "-", "-C", cwd, "--null", "-T", "-"], outPath, fileList);
    return;
  }

  const excludes = [
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=dist",
    "--exclude=build",
    "--exclude=.next",
    "--exclude=.cache",
    "--exclude=.DS_Store",
  ];
  await runTarToFile(["-czf", "-", "-C", cwd, ...excludes, "."], outPath);
}

/**
 * Bundle ~/.pi/agent/ excluding:
 *  - sessions/ (current session shipped separately)
 *  - extensions/offload/ (this extension; avoid recursion)
 *  - extensions/<name>/ for each name in `excludeExtensions`
 *  - node_modules anywhere (server reinstalls per linux/arm)
 *  - caches, tmp, locks
 */
export async function bundlePiConfig(excludeExtensions: string[], outPath: string): Promise<void> {
  const agentDir = path.join(os.homedir(), ".pi", "agent");

  try {
    await fs.access(agentDir);
  } catch {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "pi-offload-empty-"));
    try {
      await runTarToFile(["-czf", "-", "-C", empty, "."], outPath);
      return;
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  }

  const baseExcludes = [
    "--exclude=./sessions",
    "--exclude=./extensions/offload",
    "--exclude=./offload-state",
    "--exclude=node_modules",
    "--exclude=.DS_Store",
    "--exclude=*.log",
    "--exclude=.cache",
    "--exclude=tmp",
  ];

  for (const name of excludeExtensions) {
    if (/^[\w.-]+$/.test(name)) {
      baseExcludes.push(`--exclude=./extensions/${name}`);
    }
  }

  await runTarToFile(["-czf", "-", "-C", agentDir, ...baseExcludes, "."], outPath);
}

/**
 * Collect API keys from the local process env to ship along with the offload.
 * Allowlist of known provider envs only — don't leak unrelated secrets.
 */
export function collectApiKeys(): Record<string, string> {
  const allowlist = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "MISTRAL_API_KEY",
    "DEEPSEEK_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "CEREBRAS_API_KEY",
    "TOGETHER_API_KEY",
    "FIREWORKS_API_KEY",
    "PERPLEXITY_API_KEY",
  ];
  const out: Record<string, string> = {};
  for (const k of allowlist) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

/** Extract a tar.gz file into a target directory. */
export async function extractTarGzTo(tarGzPath: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const p = spawn("tar", ["-xzf", tarGzPath, "-C", targetDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (c) => (err += c.toString()));
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar extract failed: ${err}`)),
    );
  });
}
