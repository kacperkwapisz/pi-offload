import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "./config.js";
import { PiRunner } from "./pi-runner.js";
import { packTarGz, safeExtractTarGz, streamTarGz } from "./tar-safe.js";
import type { SessionMeta, SessionRecord } from "./types.js";

const runners = new Map<string, PiRunner>();
const records = new Map<string, SessionRecord>();

const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GiB hard cap per artifact

export function sessionDir(id: string) {
  return path.join(config.dataDir, "sessions", id);
}

export function workspaceDir(id: string) {
  return path.join(sessionDir(id), "workspace");
}

export function piConfigDir(id: string) {
  return path.join(sessionDir(id), ".pi", "agent");
}

/**
 * Where pi finds the resumed session JSONL. Passed to pi via --session.
 */
export function sessionFilePath(id: string) {
  return path.join(sessionDir(id), ".pi", "agent", "sessions", "offload", "session.jsonl");
}

/** Per-session staging directory for incoming uploads. */
export function uploadStagingPath(id: string, name: string) {
  return path.join(sessionDir(id), "uploads", name);
}

async function ensureDirs(id: string) {
  await fs.mkdir(workspaceDir(id), { recursive: true });
  await fs.mkdir(piConfigDir(id), { recursive: true });
  await fs.mkdir(path.dirname(sessionFilePath(id)), { recursive: true });
  await fs.mkdir(path.join(sessionDir(id), "uploads"), { recursive: true });
}

export function getRecord(id: string): SessionRecord | undefined {
  return records.get(id);
}

export function listRecords(): SessionRecord[] {
  return [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function getRunners(): PiRunner[] {
  return [...runners.values()];
}

export async function createSession(meta: SessionMeta): Promise<SessionRecord> {
  const id = nanoid(12);
  const record: SessionRecord = {
    id,
    viewKey: nanoid(24),
    createdAt: Date.now(),
    state: "pending",
    meta,
    stats: { turns: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, errorCount: 0 },
    uploads: { workspace: false, session: false, piConfig: false },
  };
  await ensureDirs(id);
  records.set(id, record);
  await persistRecord(record);
  return record;
}

/**
 * Stream an incoming web ReadableStream to a file on disk with a hard byte cap.
 * Throws if the cap is exceeded mid-write (and removes the partial file).
 */
export async function streamToFile(
  body: ReadableStream<Uint8Array> | null,
  destPath: string,
  maxBytes: number = MAX_UPLOAD_BYTES,
): Promise<number> {
  if (!body) throw new Error("missing request body");
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  let written = 0;
  const ws = createWriteStream(destPath);
  const nodeReadable = Readable.fromWeb(body as any);

  try {
    await pipeline(
      nodeReadable,
      async function* (source) {
        for await (const chunk of source as AsyncIterable<Buffer | Uint8Array>) {
          const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
          written += buf.length;
          if (written > maxBytes) {
            throw new Error(`upload exceeds ${maxBytes} bytes`);
          }
          yield buf;
        }
      },
      ws,
    );
  } catch (err) {
    await fs.unlink(destPath).catch(() => undefined);
    throw err;
  }
  return written;
}

export async function ingestWorkspace(id: string, body: ReadableStream<Uint8Array> | null): Promise<void> {
  const rec = records.get(id);
  if (!rec) throw new Error(`session ${id} not found`);
  const stage = uploadStagingPath(id, "workspace.tar.gz");
  await streamToFile(body, stage);
  await safeExtractTarGz(stage, workspaceDir(id));
  await fs.unlink(stage).catch(() => undefined);
  rec.uploads.workspace = true;
  await persistRecord(rec);
}

export async function ingestPiConfig(id: string, body: ReadableStream<Uint8Array> | null): Promise<void> {
  const rec = records.get(id);
  if (!rec) throw new Error(`session ${id} not found`);
  const stage = uploadStagingPath(id, "pi-config.tar.gz");
  await streamToFile(body, stage);
  await safeExtractTarGz(stage, piConfigDir(id));
  await fs.unlink(stage).catch(() => undefined);
  rec.uploads.piConfig = true;
  await persistRecord(rec);
}

export async function ingestSession(id: string, body: ReadableStream<Uint8Array> | null): Promise<void> {
  const rec = records.get(id);
  if (!rec) throw new Error(`session ${id} not found`);
  const sf = sessionFilePath(id);
  await streamToFile(body, sf);
  rec.uploads.session = true;
  await persistRecord(rec);
}

export async function startSession(id: string): Promise<void> {
  const record = records.get(id);
  if (!record) throw new Error(`session ${id} not found`);
  if (record.state === "running") return;
  if (runners.has(id)) return;

  if (!record.uploads.workspace || !record.uploads.session || !record.uploads.piConfig) {
    const missing = Object.entries(record.uploads)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    throw new Error(`cannot start: missing uploads: ${missing.join(", ")}`);
  }

  const runner = new PiRunner({
    sessionDir: sessionDir(id),
    workspaceDir: workspaceDir(id),
    sessionFile: sessionFilePath(id),
    record,
    onExit: () => {
      runners.delete(id);
      void persistRecord(record);
    },
  });
  runners.set(id, runner);
  await runner.start();
  await persistRecord(record);
}

export async function stopSession(id: string): Promise<void> {
  const runner = runners.get(id);
  if (runner) await runner.stop("user");
}

export async function deleteSession(id: string): Promise<void> {
  await stopSession(id);
  records.delete(id);
  runners.delete(id);
  await fs.rm(sessionDir(id), { recursive: true, force: true });
}

/** Stream workspace as tar.gz for download. */
export async function workspaceTarStream(id: string) {
  const tmp = path.join(sessionDir(id), "workspace.out.tar.gz");
  await packTarGz(workspaceDir(id), tmp);
  return { stream: streamTarGz(tmp), cleanup: async () => fs.unlink(tmp).catch(() => undefined) };
}

async function persistRecord(record: SessionRecord): Promise<void> {
  const safe: SessionRecord = {
    ...record,
    meta: { ...record.meta, apiKeys: {} },
  };
  const file = path.join(sessionDir(record.id), "record.json");
  try {
    await fs.writeFile(file, JSON.stringify(safe, null, 2));
  } catch {
    /* best-effort */
  }
}

export async function rehydrate(): Promise<void> {
  const base = path.join(config.dataDir, "sessions");
  let dirs: string[];
  try {
    dirs = await fs.readdir(base);
  } catch {
    return;
  }
  for (const id of dirs) {
    const recFile = path.join(base, id, "record.json");
    try {
      const text = await fs.readFile(recFile, "utf8");
      const rec = JSON.parse(text) as SessionRecord;
      if (rec.state === "running") {
        rec.state = "error";
        rec.error = "container restarted while running";
      }
      // Older records may not have uploads — assume true if state advanced beyond pending.
      if (!rec.uploads) {
        rec.uploads = {
          workspace: rec.state !== "pending",
          session: rec.state !== "pending",
          piConfig: rec.state !== "pending",
        };
      }
      records.set(id, rec);
    } catch {
      /* skip */
    }
  }
}

/** Graceful shutdown: stop all running children, give them 5s, then SIGKILL. */
export async function shutdownAll(): Promise<void> {
  const stops = [...runners.values()].map((r) => r.gracefulExit(5000));
  await Promise.allSettled(stops);
}
