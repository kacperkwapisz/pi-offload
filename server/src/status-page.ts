/**
 * Server-rendered HTML shell that polls /s/:id/data for live updates.
 * No build step, no framework — just enough to glance at while driving.
 */
export function renderStatusPage(id: string, viewKey: string): string {
  // Both `id` and `viewKey` are server-generated nanoid strings (safe charset),
  // so they don't need HTML-escaping. We assert that here to fail fast if that
  // assumption ever changes.
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]*$/.test(viewKey)) {
    return "<!doctype html><meta charset=utf-8><title>error</title>bad id";
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0a0a0a">
<title>pi-offload · ${id}</title>
<style>
  :root {
    color-scheme: dark light;
    --bg: #0a0a0a;
    --fg: #e8e8e8;
    --muted: #888;
    --card: #161616;
    --border: #262626;
    --accent: #7dd3fc;
    --ok: #4ade80;
    --warn: #fbbf24;
    --err: #f87171;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #fafafa;
      --fg: #1a1a1a;
      --muted: #666;
      --card: #fff;
      --border: #e5e5e5;
      --accent: #0284c7;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
  main { max-width: 640px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .badge {
    display: inline-block; padding: 3px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
    background: var(--border); color: var(--fg); text-transform: uppercase;
  }
  .badge.running { background: rgba(125,211,252,0.18); color: var(--accent); }
  .badge.done { background: rgba(74,222,128,0.18); color: var(--ok); }
  .badge.error { background: rgba(248,113,113,0.18); color: var(--err); }
  .badge.pending { background: rgba(251,191,36,0.18); color: var(--warn); }
  .badge.stopped { background: var(--border); color: var(--muted); }
  .grid {
    display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
    margin: 16px 0 24px;
  }
  .stat {
    background: var(--card); border: 1px solid var(--border); border-radius: 10px;
    padding: 12px 14px;
  }
  .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
  .stat .value { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .section { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px; margin-bottom: 12px; }
  .section .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .section .value { font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 13px; word-break: break-word; white-space: pre-wrap; }
  .meta-row { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 4px; }
  .pulse { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); margin-right: 6px; vertical-align: middle; animation: pulse 1.4s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
  footer { color: var(--muted); font-size: 11px; text-align: center; margin-top: 24px; }
</style>
</head>
<body>
<main>
  <div id="status-badge"><span class="badge pending">loading…</span></div>
  <h1 id="project">…</h1>
  <div class="sub" id="sub">—</div>

  <div class="grid">
    <div class="stat"><div class="label">Turns</div><div class="value" id="turns">0</div></div>
    <div class="stat"><div class="label">Tokens</div><div class="value" id="tokens">0</div></div>
    <div class="stat"><div class="label">Cost</div><div class="value" id="cost">$0.00</div></div>
    <div class="stat"><div class="label">Errors</div><div class="value" id="errors">0</div></div>
  </div>

  <div class="section">
    <div class="label">Last tool</div>
    <div class="value" id="last-tool">—</div>
  </div>

  <div class="section">
    <div class="label">Last assistant message</div>
    <div class="value" id="last-message">—</div>
  </div>

  <div class="section" id="error-section" style="display:none">
    <div class="label" style="color:var(--err)">Error</div>
    <div class="value" id="error-text">—</div>
  </div>

  <div class="meta-row">
    <span id="started">—</span>
    <span id="updated">—</span>
  </div>

  <footer>pi-offload · ${id}</footer>
</main>

<script>
const ID = ${JSON.stringify(id)};
const K = ${JSON.stringify(viewKey)};

function fmtAgo(ts) {
  if (!ts) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function fmtTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1) + "k";
  return (n / 1000000).toFixed(2) + "M";
}

async function tick() {
  try {
    const res = await fetch("/s/" + ID + "/data?k=" + encodeURIComponent(K), { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const r = await res.json();
    const s = r.stats || {};

    document.getElementById("project").textContent = r.meta?.projectName || ID;
    document.getElementById("sub").textContent = (r.meta?.originalCwd || "") + (r.meta?.model ? " · " + r.meta.model : "");
    document.getElementById("turns").textContent = s.turns ?? 0;
    document.getElementById("tokens").textContent = fmtTokens((s.tokensIn || 0) + (s.tokensOut || 0));
    document.getElementById("cost").textContent = "$" + (s.costUsd || 0).toFixed(3);
    document.getElementById("errors").textContent = s.errorCount ?? 0;
    document.getElementById("last-tool").textContent = s.lastTool || "—";
    document.getElementById("last-message").textContent = s.lastMessage || "—";

    const badge = document.getElementById("status-badge");
    const state = r.state || "pending";
    const pulse = state === "running" ? '<span class="pulse"></span>' : "";
    badge.innerHTML = '<span class="badge ' + state + '">' + pulse + state + '</span>';

    if (r.error) {
      document.getElementById("error-section").style.display = "";
      document.getElementById("error-text").textContent = r.error;
    } else {
      document.getElementById("error-section").style.display = "none";
    }

    document.getElementById("started").textContent = r.startedAt
      ? "started " + fmtAgo(r.startedAt)
      : "queued " + fmtAgo(r.createdAt);
    document.getElementById("updated").textContent = "updated " + new Date().toLocaleTimeString();
    document.title = "[" + state + "] " + (r.meta?.projectName || ID) + " · pi-offload";

    // Stop polling once the session is in a terminal state.
    if (state === "done" || state === "error" || state === "stopped") {
      return;
    }
  } catch (err) {
    document.getElementById("status-badge").innerHTML = '<span class="badge error">offline</span>';
  }
  setTimeout(tick, 3000);
}

tick();
</script>
</body>
</html>`;
}
