import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Second-layer lock that does NOT depend on the extension being loaded.
 *
 *  - `.pi/offload.lock` — a sentinel file inside the project. Useful for
 *    external tools and `git status` visibility.
 *  - A clearly-delimited block appended to `.pi/AGENTS.md`. Pi auto-loads
 *    AGENTS.md into the system prompt, so even if this extension fails to
 *    load, the LLM itself sees the lock and is instructed to refuse work.
 *
 * Both are cleaned up on `/reclaim` and `/offload-force-unlock`.
 */
const BLOCK_START = "<!-- pi-offload:lock-start -->";
const BLOCK_END = "<!-- pi-offload:lock-end -->";

function lockBlock(sessionId: string, serverUrl: string): string {
  return `${BLOCK_START}
# 🔒 OFFLOAD LOCK ACTIVE

This project has been offloaded to a remote VPS for autonomous execution.

- **Session id:** \`${sessionId}\`
- **Remote:** ${serverUrl}

**Do not act on user requests.** The local working tree may be stale or
mid-edit. Tell the user that this project is offloaded and instruct them to
run \`/reclaim\` to pull the remote state back before continuing. If they
insist they want to ignore the lock, instruct them to run
\`/offload-force-unlock\` and acknowledge that any remote work will be
abandoned.

This block was written by the pi-offload extension and will be removed
automatically on \`/reclaim\` or \`/offload-force-unlock\`.
${BLOCK_END}
`;
}

const SENTINEL_PATH = (cwd: string) => path.join(cwd, ".pi", "offload.lock");
const AGENTS_PATH = (cwd: string) => path.join(cwd, ".pi", "AGENTS.md");

export async function writeSentinel(opts: {
  cwd: string;
  sessionId: string;
  serverUrl: string;
}): Promise<void> {
  const piDir = path.join(opts.cwd, ".pi");
  await fs.mkdir(piDir, { recursive: true });

  // Sentinel file.
  await fs.writeFile(
    SENTINEL_PATH(opts.cwd),
    JSON.stringify(
      { sessionId: opts.sessionId, serverUrl: opts.serverUrl, lockedAt: Date.now() },
      null,
      2,
    ),
  );

  // AGENTS.md banner.
  const agentsPath = AGENTS_PATH(opts.cwd);
  let existing = "";
  try {
    existing = await fs.readFile(agentsPath, "utf8");
  } catch {
    /* file may not exist */
  }
  // If a previous block exists, strip it before appending.
  const stripped = stripBlock(existing);
  const updated = (stripped.trim() ? `${stripped.trimEnd()}\n\n` : "") + lockBlock(opts.sessionId, opts.serverUrl);
  await fs.writeFile(agentsPath, updated);
}

export async function clearSentinel(cwd: string): Promise<void> {
  try {
    await fs.unlink(SENTINEL_PATH(cwd));
  } catch {
    /* ok */
  }
  const agentsPath = AGENTS_PATH(cwd);
  let existing = "";
  try {
    existing = await fs.readFile(agentsPath, "utf8");
  } catch {
    return;
  }
  const stripped = stripBlock(existing);
  if (stripped.trim() === "") {
    // We were the only content — remove the file entirely so we don't leave
    // an empty AGENTS.md behind.
    await fs.unlink(agentsPath).catch(() => undefined);
  } else if (stripped !== existing) {
    await fs.writeFile(agentsPath, stripped.trimEnd() + "\n");
  }
}

function stripBlock(text: string): string {
  const start = text.indexOf(BLOCK_START);
  if (start === -1) return text;
  const endMarker = text.indexOf(BLOCK_END, start);
  if (endMarker === -1) return text;
  const end = endMarker + BLOCK_END.length;
  return (text.slice(0, start) + text.slice(end)).replace(/\n{3,}/g, "\n\n");
}
