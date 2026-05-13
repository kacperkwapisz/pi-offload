import { config } from "./config.js";

const API_BASE = "https://activitysmith.com/api";

interface MetricEntry {
  label: string;
  value: number;
  unit?: string;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${config.activitySmithApiKey}`,
    "Content-Type": "application/json",
  };
}

function targetField() {
  return config.activitySmithChannel
    ? { target: { channels: [config.activitySmithChannel] } }
    : {};
}

function streamKey(sessionId: string) {
  // ActivitySmith stream_key — stable per session.
  return `pi-offload-${sessionId}`;
}

async function safeFetch(url: string, init: RequestInit, what: string) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[activitysmith] ${what} failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.warn(`[activitysmith] ${what} error:`, err);
  }
}

/**
 * Start or update a metrics-type Live Activity for this session.
 * Uses the stream endpoint so we don't need to track activity_id.
 */
export async function updateLiveActivity(opts: {
  sessionId: string;
  projectName: string;
  subtitle?: string;
  metrics: MetricEntry[];
  actionUrl?: string;
}) {
  await safeFetch(
    `${API_BASE}/live-activity/stream/${encodeURIComponent(streamKey(opts.sessionId))}`,
    {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        content_state: {
          title: opts.projectName,
          subtitle: opts.subtitle ?? "running",
          type: "metrics",
          metrics: opts.metrics,
        },
        ...(opts.actionUrl
          ? {
              action: {
                title: "Open",
                type: "open_url",
                url: opts.actionUrl,
              },
            }
          : {}),
        ...targetField(),
      }),
    },
    "live activity stream update",
  );
}

/** End the Live Activity for a session. */
export async function endLiveActivity(opts: {
  sessionId: string;
  projectName: string;
  subtitle: string;
  metrics: MetricEntry[];
}) {
  await safeFetch(
    `${API_BASE}/live-activity/stream/${encodeURIComponent(streamKey(opts.sessionId))}`,
    {
      method: "DELETE",
      headers: authHeaders(),
      body: JSON.stringify({
        content_state: {
          title: opts.projectName,
          subtitle: opts.subtitle,
          type: "metrics",
          metrics: opts.metrics,
          auto_dismiss_minutes: 5,
        },
        ...targetField(),
      }),
    },
    "live activity stream end",
  );
}

/** Send a one-off push notification. */
export async function pushNotification(opts: {
  title: string;
  message?: string;
  redirectionUrl?: string;
}) {
  await safeFetch(
    `${API_BASE}/push-notification`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        title: opts.title,
        ...(opts.message ? { message: opts.message } : {}),
        ...(opts.redirectionUrl ? { redirection: { url: opts.redirectionUrl } } : {}),
        ...targetField(),
      }),
    },
    "push notification",
  );
}
