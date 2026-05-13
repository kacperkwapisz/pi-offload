export type SessionState =
  | "pending"      // uploaded, not yet started
  | "running"      // pi --mode rpc is alive
  | "done"         // agent finished cleanly
  | "error"        // pi crashed or exited with error
  | "stopped";     // DELETE'd while running

export interface SessionMeta {
  /** Display name for the project (basename of original cwd). */
  projectName: string;
  /** Original local cwd (informational only). */
  originalCwd: string;
  /** Model id, e.g. "anthropic/claude-sonnet-4-5". */
  model?: string;
  /** Thinking level if set. */
  thinkingLevel?: string;
  /** Prompt sent on /start. If empty, a default is used. */
  kickoffPrompt?: string;
  /** API keys to make available to the in-container pi. Wiped on DELETE. */
  apiKeys: Record<string, string>;
}

export interface SessionRecord {
  id: string;
  /** Random per-session token granting read-only access via the public status page. */
  viewKey: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  state: SessionState;
  meta: SessionMeta;
  /** Live stats updated as events stream in. */
  stats: {
    turns: number;
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
    lastTool?: string;
    lastMessage?: string;
    errorCount: number;
  };
  /** Last error message if state === "error". */
  error?: string;
  /** Tracks which artifacts have been uploaded for this session. */
  uploads: {
    workspace: boolean;
    session: boolean;
    piConfig: boolean;
  };
}
