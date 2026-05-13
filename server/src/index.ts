import { serve } from "@hono/node-server";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { Context } from "hono";
import { config } from "./config.js";
import {
  createSession,
  deleteSession,
  getRecord,
  ingestPiConfig,
  ingestSession,
  ingestWorkspace,
  listRecords,
  rehydrate,
  sessionFilePath,
  shutdownAll,
  startSession,
  stopSession,
  workspaceTarStream,
} from "./sessions.js";
import { renderStatusPage } from "./status-page.js";
import type { SessionMeta } from "./types.js";

const app = new Hono();

// Bearer auth for everything under /sessions.
app.use("/sessions/*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  if (auth !== `Bearer ${config.offloadToken}`) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true, ts: Date.now() }));

// --- Create a session (meta only) ----------------------------------------
// Body: SessionMeta JSON. Workspace / session / pi-config are then uploaded
// via separate streaming PUTs to avoid buffering large bundles in memory.
app.post("/sessions", async (c) => {
  let meta: SessionMeta;
  try {
    meta = (await c.req.json()) as SessionMeta;
  } catch {
    return c.json({ error: "body must be JSON SessionMeta" }, 400);
  }
  if (!meta?.projectName || !meta?.originalCwd) {
    return c.json({ error: "meta.projectName and meta.originalCwd required" }, 400);
  }
  if (!meta.apiKeys || typeof meta.apiKeys !== "object") meta.apiKeys = {};

  const rec = await createSession(meta);
  return c.json({
    id: rec.id,
    state: rec.state,
    viewKey: rec.viewKey,
    upload: {
      workspace: `${config.appUrl}/sessions/${rec.id}/workspace`,
      session: `${config.appUrl}/sessions/${rec.id}/session`,
      piConfig: `${config.appUrl}/sessions/${rec.id}/pi-config`,
    },
  });
});

// --- Streaming PUT uploads ------------------------------------------------
async function streamPutHandler(
  c: Context<any, any, any>,
  ingest: (id: string, body: ReadableStream<Uint8Array> | null) => Promise<void>,
): Promise<Response> {
  const id = c.req.param("id");
  if (!id || !getRecord(id)) return c.json({ error: "not found" }, 404);
  try {
    await ingest(id, c.req.raw.body);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
}

app.put("/sessions/:id/workspace", async (c) => streamPutHandler(c, ingestWorkspace));
app.put("/sessions/:id/pi-config", async (c) => streamPutHandler(c, ingestPiConfig));
app.put("/sessions/:id/session", async (c) => streamPutHandler(c, ingestSession));

// --- Start agent execution ------------------------------------------------
app.post("/sessions/:id/start", async (c) => {
  const id = c.req.param("id");
  const rec = getRecord(id);
  if (!rec) return c.json({ error: "not found" }, 404);
  if (rec.state === "running") return c.json({ id, state: "running", note: "already running" });
  try {
    await startSession(id);
    return c.json({ id, state: rec.state });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// --- Status ---------------------------------------------------------------
app.get("/sessions", (c) => {
  const list = listRecords().map((r) => ({
    id: r.id,
    state: r.state,
    projectName: r.meta.projectName,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    stats: r.stats,
  }));
  return c.json({ sessions: list });
});

app.get("/sessions/:id", (c) => {
  const id = c.req.param("id");
  const rec = getRecord(id);
  if (!rec) return c.json({ error: "not found" }, 404);
  const { apiKeys: _, ...metaSafe } = rec.meta;
  return c.json({ ...rec, meta: metaSafe });
});

// --- Pull session JSONL back ---------------------------------------------
app.get("/sessions/:id/session.jsonl", async (c) => {
  const id = c.req.param("id");
  if (!getRecord(id)) return c.json({ error: "not found" }, 404);
  try {
    const data = await fs.readFile(sessionFilePath(id));
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": "application/x-ndjson",
        "content-disposition": `attachment; filename="session-${id}.jsonl"`,
      },
    });
  } catch (err) {
    return c.json({ error: `read failed: ${(err as Error).message}` }, 500);
  }
});

// --- Pull workspace tar.gz back ------------------------------------------
app.get("/sessions/:id/workspace.tar.gz", async (c) => {
  const id = c.req.param("id");
  if (!getRecord(id)) return c.json({ error: "not found" }, 404);

  const { stream: rs, cleanup } = await workspaceTarStream(id);
  return stream(c, async (out) => {
    c.header("content-type", "application/gzip");
    c.header("content-disposition", `attachment; filename="workspace-${id}.tar.gz"`);
    try {
      for await (const chunk of rs) {
        await out.write(chunk);
      }
    } finally {
      await cleanup();
    }
  });
});

// --- Stop / delete --------------------------------------------------------
app.post("/sessions/:id/stop", async (c) => {
  const id = c.req.param("id");
  if (!getRecord(id)) return c.json({ error: "not found" }, 404);
  await stopSession(id);
  return c.json({ id, state: getRecord(id)?.state });
});

app.delete("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  if (!getRecord(id)) return c.json({ error: "not found" }, 404);
  await deleteSession(id);
  return c.json({ id, deleted: true });
});

// --- Public status page (no bearer; per-session view key) ----------------
function authorizeView(c: Context, id: string): { ok: true } | { ok: false; res: Response } {
  const rec = getRecord(id);
  if (!rec) return { ok: false, res: c.json({ error: "not found" }, 404) };
  const auth = c.req.header("authorization") ?? "";
  const queryKey = c.req.query("k") ?? "";
  if (auth === `Bearer ${config.offloadToken}`) return { ok: true };
  if (queryKey && queryKey === rec.viewKey) return { ok: true };
  return { ok: false, res: c.json({ error: "unauthorized" }, 401) };
}

app.get("/s/:id/data", (c) => {
  const id = c.req.param("id");
  const auth = authorizeView(c, id);
  if (!auth.ok) return auth.res;
  const rec = getRecord(id)!;
  const { apiKeys: _, ...metaSafe } = rec.meta;
  return c.json({ ...rec, meta: metaSafe, viewKey: undefined });
});

app.get("/s/:id", (c) => {
  const id = c.req.param("id");
  const auth = authorizeView(c, id);
  if (!auth.ok) return auth.res;
  const k = c.req.query("k") ?? "";
  c.header("content-type", "text/html; charset=utf-8");
  return c.body(renderStatusPage(id, k));
});

// --- Boot -----------------------------------------------------------------
// Register signal handlers BEFORE serve() so they're installed before any
// signal can arrive. (In practice the order also affects whether handlers
// reliably fire under Node when the event loop is busy holding a listener.)
let server: ReturnType<typeof serve> | undefined;
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${signal}] shutting down…`);
  try {
    await shutdownAll();
  } catch (err) {
    console.error("shutdownAll error:", err);
  }
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

await rehydrate();

console.log(`pi-offload-server listening on :${config.port}`);
server = serve({ fetch: app.fetch, port: config.port });
