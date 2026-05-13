import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Per-project offload lock state. */
export interface OffloadState {
  id: string;
  serverUrl: string;
  startedAt: number;
  projectPath: string;
  projectName: string;
}

const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "offload-state");

function projectHash(projectPath: string): string {
  return createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
}

function stateFile(projectPath: string): string {
  return path.join(STATE_DIR, `${projectHash(projectPath)}.json`);
}

export async function readState(projectPath: string): Promise<OffloadState | null> {
  try {
    const text = await fs.readFile(stateFile(projectPath), "utf8");
    return JSON.parse(text) as OffloadState;
  } catch {
    return null;
  }
}

export async function writeState(state: OffloadState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(stateFile(state.projectPath), JSON.stringify(state, null, 2));
}

export async function clearState(projectPath: string): Promise<void> {
  try {
    await fs.unlink(stateFile(projectPath));
  } catch {
    // ok
  }
}
