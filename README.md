# pi-offload

Offload a running `pi` coding-agent session to a remote VPS so you can close your laptop and have the work continue in the cloud. Progress streams to your iPhone via [ActivitySmith](https://activitysmith.com) Live Activities + push notifications.

Two pieces:

- **`server/`** — Docker container deployed on your VPS. Wraps `pi --mode rpc`, exposes a small HTTP API, and pipes progress to ActivitySmith.
- **`extension/`** — A pi extension installed at `~/.pi/agent/extensions/offload/`. Adds `/offload`, `/reclaim`, `/offload-status`, `/offload-setup`, and `/offload-force-unlock` commands.

## Flow

1. Plan your work locally with pi.
2. `/offload` → bundles workspace + session + your `~/.pi/agent/` config, ships it to the VPS, starts pi in a sandboxed container with the implicit instruction "proceed with the plan, work autonomously, report when done," then shuts down local pi.
3. Close your laptop, drive away. Live Activity on your iPhone shows turn count, tokens, and cost in real time.
4. Get a push notification when the agent finishes.
5. Open laptop, `/reclaim` → pulls the updated workspace and session back, unlocks the project locally.

While a project is offloaded, the local pi extension blocks all input in that project's directory except `/reclaim`, `/offload-status`, and `/offload-force-unlock`. A sentinel file at `.pi/offload.lock` plus a banner injected into `.pi/AGENTS.md` ensures the lock holds even if the extension fails to load on a future pi version.

## Install

### Extension (your laptop)

```bash
pi install git:github.com/kacperkwapisz/pi-offload@main
```

Then run the one-time config wizard inside pi:

```text
/offload-setup
```

You'll be asked for the server URL and bearer token; the wizard pings `/health` to confirm connectivity before saving to `~/.pi/agent/offload-config.json`.

To pin to a specific release:

```bash
pi install git:github.com/kacperkwapisz/pi-offload@v0.1.0
```

To try without installing globally:

```bash
pi -e git:github.com/kacperkwapisz/pi-offload
```

To update later:

```bash
pi update git:github.com/kacperkwapisz/pi-offload
```

To remove:

```bash
pi remove git:github.com/kacperkwapisz/pi-offload
```

### Server (your VPS)

The image is published to GHCR as a public package, signed with cosign:

```bash
docker run -d \
  --name pi-offload \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:size=512m \
  --tmpfs /home/node/.npm:size=256m \
  -v pi-offload-data:/data \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 512 \
  --memory 4g --cpus 2 \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  ghcr.io/kacperkwapisz/pi-offload-server:latest
```

`.env` needs `APP_URL`, `OFFLOAD_TOKEN` (use `openssl rand -hex 32`), and `ACTIVITYSMITH_API_KEY`. See `server/README.md` for the full list and reverse-proxy guidance.

## Roadmap

- **Remote steering** (`/offload-prompt "<message>"`): add a `POST /sessions/:id/prompt` endpoint that forwards a `{type:"steer",...}` or `{type:"follow_up",...}` RPC command to the running pi child. The transport plumbing exists already — the RPC server already accepts steer/follow_up. Roughly ~30 lines on the server + a new command in the extension. Left out of v1 because the current trigger model is "plan locally, then offload+go"; this is the obvious next addition the first time you find yourself wanting to talk to the remote agent mid-run.
