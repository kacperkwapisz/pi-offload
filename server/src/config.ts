function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  appUrl: required("APP_URL"),
  offloadToken: required("OFFLOAD_TOKEN"),
  activitySmithApiKey: required("ACTIVITYSMITH_API_KEY"),
  activitySmithChannel: optional("ACTIVITYSMITH_CHANNEL", ""),
  dataDir: optional("DATA_DIR", "/data"),
  port: Number.parseInt(optional("PORT", "3000"), 10),
  notifyLevel: optional("NOTIFY_LEVEL", "errors-only") as "off" | "errors-only" | "all",
};
