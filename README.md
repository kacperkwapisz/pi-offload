# pi-offload

Offload a running `pi` coding-agent session to a remote VPS so you can close your laptop and have the work continue in the cloud.

Two pieces:

- **`server/`** — Docker container deployed on your VPS. Wraps `pi --mode rpc`, exposes a small HTTP API, and pipes progress to [ActivitySmith](https://activitysmith.com) for iOS Live Activities + push notifications.
- **`extension/`** — A pi extension installed at `~/.pi/agent/extensions/offload/`. Adds `/offload`, `/reclaim`, `/offload-status`, and `/offload-force-unlock` commands.

## Flow

1. Plan your work locally with pi.
2. `/offload` → bundles workspace + session + your `~/.pi/agent/` config, ships them to the VPS, starts pi in a sandboxed container with the implicit instruction "proceed with the plan, work autonomously, report when done," then shuts down local pi.
3. Close your laptop, drive away. Live Activity on your iPhone shows turn count, tokens, and cost in real time.
4. Get a push notification when the agent finishes.
5. Open laptop, `/reclaim` → pulls the updated workspace and session back, unlocks the project locally.

While a project is offloaded, the local pi extension blocks all input in that project's directory except `/reclaim`, `/offload-status`, and `/offload-force-unlock`.

## Setup

See `server/README.md` for VPS deployment, and `extension/README.md` for the pi extension install.

## Roadmap

- **Remote steering** (`/offload-prompt "<message>"`): add a `POST /sessions/:id/prompt` endpoint that forwards a `{type:"steer",...}` or `{type:"follow_up",...}` RPC command to the running pi child. The transport plumbing exists already — the RPC server already accepts steer/follow_up. Roughly ~30 lines on the server + a new command in the extension. Left out of v1 because the current trigger model is "plan locally, then offload+go"; this is the obvious next addition the first time you find yourself wanting to talk to the remote agent mid-run.
