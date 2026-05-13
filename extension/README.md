# pi-offload extension

pi extension that adds `/offload`, `/reclaim`, `/offload-status`, and `/offload-force-unlock` commands.

## Install

Symlink (or copy) this directory into `~/.pi/agent/extensions/offload/`:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/offload
```

Then create `~/.pi/agent/offload-config.json`:

```json
{
  "serverUrl": "https://pi-offload.yourdomain.com",
  "token": "the-OFFLOAD_TOKEN-from-the-server-env",
  "excludeExtensions": [],
  "kickoffPrompt": null
}
```

Fields:

- `serverUrl` — public HTTPS URL of the pi-offload-server.
- `token` — must match `OFFLOAD_TOKEN` on the server.
- `excludeExtensions` (optional) — extension directory names under `~/.pi/agent/extensions/` to skip when bundling. Use this for extensions that depend on local-only resources (e.g. macOS-only tools, local app integrations). The `offload` extension itself is always excluded automatically.
- `kickoffPrompt` (optional) — overrides the default "proceed with the plan above" instruction sent to the remote agent.

## Commands

### `/offload`

Bundle the current workspace + session + your `~/.pi/agent/` config, upload to the VPS, start a sandboxed pi there, send the kickoff prompt, lock this project locally, and shut down local pi.

The lock is per-project (per cwd). Other projects continue to work normally. You can offload multiple projects in parallel.

### `/offload-status`

Show the current state of the remote session (turns, tokens, cost, last tool). Works without unlocking.

### `/reclaim`

Pull the updated workspace and session back from the VPS, overwrite local files, delete the remote session, and clear the lock. Refuses to run if the remote is still active — pass `--force` to stop the remote first.

After reclaim, restart pi (or `pi -c` / `/resume`) to load the updated session.

### `/offload-force-unlock`

Clear the lock without pulling remote state. Use only if the VPS is unreachable — any work the remote agent did stays on the VPS.

## Locked-project behavior

While a project is offloaded, any user input in its cwd except the four offload commands is intercepted and replaced with a notice telling you the project is locked.

## What gets shipped on `/offload`

- **Workspace**: in a git repo, `git ls-files -co --exclude-standard` (honours `.gitignore` exactly). Otherwise tar with a small junk-list of excludes. `.git/` is always excluded.
- **Session JSONL**: the current session file as-is.
- **Pi config**: `~/.pi/agent/` excluding `sessions/`, `extensions/offload/`, `offload-state/`, any extension named in `excludeExtensions`, and `node_modules/` anywhere. The server re-runs `npm install --omit=dev` in each extension directory that has a `package.json`, so native bindings end up correctly compiled for the container's platform.
- **API keys**: a fixed allowlist of provider env vars (Anthropic, OpenAI, Google, Groq, Mistral, DeepSeek, xAI, OpenRouter, Cerebras, Together, Fireworks, Perplexity) read from your local environment. Sent over the wire, held in memory by the container only, never persisted to disk on the VPS.

## Reclaim caveats

- Reclaim overwrites local files with remote files. Local changes made during the offload window will be clobbered. (You can't make them anyway — the lock blocks input.)
- Files deleted by the remote agent will NOT be deleted locally during extraction (tar doesn't delete). Run `git status` after reclaim and clean up if needed.
