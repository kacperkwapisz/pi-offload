# pi-offload-server

HTTP service that wraps `pi --mode rpc` inside a sandboxed Docker container on a VPS. Receives offloaded sessions from the local pi extension, runs them, and reports progress via [ActivitySmith](https://activitysmith.com) push notifications + Live Activities.

## Image

Prebuilt images (linux/amd64) are published to GHCR by the [`build-server`](../.github/workflows/build-server.yml) workflow:

```
ghcr.io/<owner>/pi-offload-server:latest
ghcr.io/<owner>/pi-offload-server:sha-<short>
ghcr.io/<owner>/pi-offload-server:v1.2.3   # on release tags
```

Each published digest is signed with cosign (keyless, Sigstore OIDC). Verify before pulling:

```bash
cosign verify \
  --certificate-identity-regexp 'https://github.com/<owner>/pi-offload/.github/workflows/build-server.yml@.*' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/<owner>/pi-offload-server@sha256:<digest>
```

Images also carry an SLSA build provenance attestation and an SBOM, both attached to the image in the registry. Inspect with `cosign download attestation` or `docker buildx imagetools inspect`.

## Build locally

```bash
docker build -t pi-offload:latest .
```

## Deploy

Copy `.env.example` to `.env` on the VPS and fill in the values:

```bash
cp .env.example .env
$EDITOR .env
```

Generate a strong bearer token:

```bash
openssl rand -hex 32
```

Run the container. The flags below are the recommended sandboxed setup — the container has no host bind-mounts other than the data volume, drops all capabilities, runs read-only with a tmpfs for `/tmp`, and binds only to localhost so your existing reverse proxy can terminate TLS in front of it.

```bash
docker run -d \
  --name pi-offload \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:size=512m \
  --tmpfs /home/pi/.npm:size=256m \
  -v pi-offload-data:/data \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 512 \
  --memory 4g --cpus 2 \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  pi-offload:latest
```

The volume `pi-offload-data` must be owned by uid 1000 inside the container. If it's a fresh named volume Docker handles this. If you mount a host directory, ensure it's `chown 1000:1000`.

Point your reverse proxy at `127.0.0.1:3000` and terminate TLS upstream. The public hostname must match `APP_URL` in `.env`.

## API

All endpoints require `Authorization: Bearer $OFFLOAD_TOKEN`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/health` | Liveness probe (no auth) |
| `GET`  | `/s/:id?k=<viewKey>` | Public-ish HTML status page (uses per-session view key; what ActivitySmith opens) |
| `GET`  | `/s/:id/data?k=<viewKey>` | JSON backing the status page (auto-refresh source) |
| `POST` | `/sessions` | Create a session (metadata only); returns `{ id, state, viewKey, upload: { workspace, session, piConfig } }` with absolute URLs for the streaming uploads |
| `PUT`  | `/sessions/:id/workspace` | Stream a tar.gz of the working tree (validated against path traversal, symlinks, etc.) |
| `PUT`  | `/sessions/:id/session` | Stream the session.jsonl |
| `PUT`  | `/sessions/:id/pi-config` | Stream a tar.gz of `~/.pi/agent/` config |
| `POST` | `/sessions/:id/start` | Spawn pi and send the kickoff prompt (all three uploads must be complete) |
| `GET`  | `/sessions` | List all sessions |
| `GET`  | `/sessions/:id` | Status + stats |
| `GET`  | `/sessions/:id/session.jsonl` | Pull updated session JSONL |
| `GET`  | `/sessions/:id/workspace.tar.gz` | Pull updated workspace |
| `POST` | `/sessions/:id/stop` | Kill the running pi process |
| `DELETE` | `/sessions/:id` | Stop and wipe the session dir |

## What's persisted

- `/data/sessions/<id>/workspace/` — the working tree
- `/data/sessions/<id>/.pi/agent/` — the bundled pi config (acts as `$HOME/.pi/agent` for the in-container pi)
- `/data/sessions/<id>/.pi/agent/sessions/offload/session.jsonl` — the resumed session
- `/data/sessions/<id>/pi.log` — stdout/stderr log of the pi process
- `/data/sessions/<id>/record.json` — session metadata (API keys are wiped before persisting)

API keys are kept **only in memory** for the lifetime of the running pi process. They are wiped when the session is stopped or deleted.

## Sandboxing notes

- Container runs as uid 1000, no capabilities, no privilege escalation.
- Root filesystem is read-only; only `/data`, `/tmp`, and `/home/pi/.npm` are writable.
- No Docker socket, no host bind-mounts outside the data volume.
- Outbound network is unrestricted (needed for LLM APIs). If you want to lock it down further, attach the container to a custom bridge with iptables rules.
- The in-container pi can do anything to its workspace, but cannot see the host.

## Development

```bash
npm install
cp .env.example .env  # then edit
npm run dev
```
