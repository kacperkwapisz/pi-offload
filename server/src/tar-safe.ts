import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Reject any path that would write outside the extraction root.
 *
 * Rules:
 *  - No absolute paths.
 *  - No `..` segments.
 *  - No leading `/` (defence-in-depth; tar may strip these but we don't trust that).
 *  - No symlinks pointing outside the root (we just refuse symlinks entirely;
 *    code workspaces rarely need them and they're a known tar-escape vector).
 */
function pathLooksUnsafe(p: string): string | null {
  if (p === "" || p === "./") return null; // tar emits these for the root
  if (path.isAbsolute(p)) return "absolute path";
  const normalized = path.posix.normalize(p);
  if (normalized.startsWith("../") || normalized === "..") return "parent traversal";
  if (normalized.split("/").includes("..")) return "embedded ..";
  return null;
}

/**
 * List paths in a tar.gz. Uses `tar -tzf` (paths only) which has a stable
 * format across GNU tar, bsdtar, and busybox tar.
 *
 * Type information is checked separately via `tar -tzvf` only when needed.
 */
async function listTarPaths(tarPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", ["-tzf", tarPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`tar list failed: ${err}`));
      const paths = out
        .split("\n")
        .map((s) => s.replace(/\r$/, ""))
        .filter(Boolean);
      resolve(paths);
    });
  });
}

/**
 * Check whether a tar.gz contains any non-regular entries (symlinks, hardlinks,
 * device files). Uses verbose listing and parses the first character of each
 * line (the type indicator), which is the one column that IS consistent across
 * tar implementations.
 */
async function tarHasNonRegular(tarPath: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", ["-tzvf", tarPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => (out += c.toString()));
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`tar list failed: ${err}`));
      for (const line of out.split("\n")) {
        const c = line[0];
        if (!c) continue;
        if (c !== "-" && c !== "d") {
          // Symlink "l", hardlink "h", char/block/socket/fifo "c"/"b"/"s"/"p".
          return resolve(`non-regular entry (type "${c}")`);
        }
      }
      resolve(null);
    });
  });
}

/**
 * Safely extract a tar.gz file into a target directory.
 *
 * Two-pass approach:
 *  1. List all entries, validate every path.
 *  2. If clean, extract with restrictive flags.
 *
 * Refuses: absolute paths, parent traversal, symlinks, hardlinks, device files.
 */
export async function safeExtractTarGz(tarPath: string, targetDir: string): Promise<void> {
  // Pass 1: refuse symlinks/hardlinks/devices outright.
  const nonRegular = await tarHasNonRegular(tarPath);
  if (nonRegular) {
    throw new Error(`refusing tar: ${nonRegular}`);
  }

  // Pass 2: validate every path is relative and contains no `..` segment.
  const paths = await listTarPaths(tarPath);
  for (const p of paths) {
    const reason = pathLooksUnsafe(p);
    if (reason) {
      throw new Error(`refusing tar entry: ${reason} at ${p}`);
    }
  }

  await fs.mkdir(targetDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      "tar",
      [
        "-xzf",
        tarPath,
        "-C",
        targetDir,
        // Defence in depth — we already validated above, but ask tar to enforce too.
        "--no-same-owner",
        "--no-same-permissions",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let err = "";
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar extract failed (${code}): ${err}`)),
    );
  });
}

/**
 * Pack a directory into a tar.gz file at outPath (streamed, doesn't buffer).
 */
export async function packTarGz(srcDir: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("tar", ["-czf", outPath, "-C", srcDir, "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar pack failed (${code}): ${err}`)),
    );
  });
}

/** Stream a tar.gz file as a Node Readable. */
export function streamTarGz(filePath: string) {
  return createReadStream(filePath);
}
