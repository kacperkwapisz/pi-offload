import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";

interface CreateResponse {
  id: string;
  state: string;
  viewKey: string;
  upload: { workspace: string; session: string; piConfig: string };
}

export class OffloadClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  /** Step 1: create a session with just metadata. */
  async createSession(meta: Record<string, unknown>): Promise<CreateResponse> {
    const res = await fetch(`${this.baseUrl}/sessions`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(meta),
    });
    if (!res.ok) throw new Error(`createSession: ${res.status} ${await res.text()}`);
    return (await res.json()) as CreateResponse;
  }

  /**
   * Step 2: stream a file from disk to one of the upload URLs.
   * Uses chunked transfer; nothing buffered in memory.
   */
  async uploadFile(uploadUrl: string, filePath: string, contentType: string): Promise<void> {
    const stat = await fs.stat(filePath);
    const nodeStream = createReadStream(filePath);
    // Convert Node Readable to a Web ReadableStream so fetch can stream it.
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;

    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: this.headers({
        "Content-Type": contentType,
        "Content-Length": String(stat.size),
      }),
      body: webStream,
      // @ts-expect-error Node-specific fetch option for half-duplex streams.
      duplex: "half",
    });
    if (!res.ok) throw new Error(`upload ${uploadUrl}: ${res.status} ${await res.text()}`);
  }

  /** Step 3: kick off the agent. */
  async start(id: string): Promise<{ id: string; state: string }> {
    const res = await fetch(`${this.baseUrl}/sessions/${id}/start`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`start: ${res.status} ${await res.text()}`);
    return (await res.json()) as { id: string; state: string };
  }

  async status(id: string): Promise<any> {
    const res = await fetch(`${this.baseUrl}/sessions/${id}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`status: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async downloadSessionJsonl(id: string, destPath: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${id}/session.jsonl`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`download session: ${res.status} ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(destPath, buf);
  }

  async downloadWorkspaceTarGz(id: string, destPath: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${id}/workspace.tar.gz`, {
      headers: this.headers(),
    });
    if (!res.ok || !res.body) throw new Error(`download workspace: ${res.status}`);
    // Stream the response body to disk.
    const { createWriteStream } = await import("node:fs");
    const ws = createWriteStream(destPath);
    const nodeReadable = Readable.fromWeb(res.body as any);
    await new Promise<void>((resolve, reject) => {
      nodeReadable.pipe(ws);
      ws.on("finish", () => resolve());
      ws.on("error", reject);
      nodeReadable.on("error", reject);
    });
  }

  async stop(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${id}/stop`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`stop: ${res.status} ${await res.text()}`);
  }

  async delete(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/sessions/${id}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`delete: ${res.status} ${await res.text()}`);
  }
}
