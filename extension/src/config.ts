import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface OffloadConfig {
  /** Base HTTPS URL of the offload server. */
  serverUrl: string;
  /** Bearer token matching the server's OFFLOAD_TOKEN. */
  token: string;
  /** Extension directory names to exclude from the pi-config bundle. */
  excludeExtensions?: string[];
  /** Override the implicit kickoff prompt. */
  kickoffPrompt?: string;
}

const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "offload-config.json");

export async function readConfig(): Promise<OffloadConfig | null> {
  try {
    const text = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(text) as OffloadConfig;
    if (!parsed.serverUrl || !parsed.token) return null;
    // Strip trailing slash for clean URL concatenation.
    parsed.serverUrl = parsed.serverUrl.replace(/\/+$/, "");
    return parsed;
  } catch {
    return null;
  }
}

export function configPath(): string {
  return CONFIG_PATH;
}
