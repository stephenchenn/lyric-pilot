import { resolve } from "node:path";

export interface AppConfig {
  adapter: "mock" | "http";
  baseUrl: string | null;
  profilePath: string;
  token: string | undefined;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  logPath: string;
}

function integer(name: string, value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const adapter = env.PROPRESENTER_ADAPTER || "mock";
  if (adapter !== "mock" && adapter !== "http") {
    throw new Error("PROPRESENTER_ADAPTER must be mock or http");
  }
  let baseUrl: string | null = null;
  if (adapter === "http") {
    if (!env.PROPRESENTER_PORT) {
      throw new Error("Set PROPRESENTER_PORT from the installed ProPresenter Network settings");
    }
    const port = integer("PROPRESENTER_PORT", env.PROPRESENTER_PORT, 1, 65535);
    const protocol = env.PROPRESENTER_PROTOCOL || "http";
    if (protocol !== "http" && protocol !== "https") {
      throw new Error("PROPRESENTER_PROTOCOL must be http or https");
    }
    const host = env.PROPRESENTER_HOST || "127.0.0.1";
    if (!/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:]+\])$/.test(host)) {
      throw new Error("PROPRESENTER_HOST must be a hostname or IP address, without a port or URL path");
    }
    baseUrl = new URL(`${protocol}://${host}:${port}`).origin;
  }
  return {
    adapter, baseUrl,
    profilePath: resolve(env.PROPRESENTER_PROFILE || "profiles/propresenter.local.json"),
    token: env.PROPRESENTER_TOKEN || undefined,
    pollIntervalMs: integer("POLL_INTERVAL_MS", env.POLL_INTERVAL_MS || "750", 100, 60_000),
    requestTimeoutMs: integer("REQUEST_TIMEOUT_MS", env.REQUEST_TIMEOUT_MS || "2500", 50, 30_000),
    logPath: resolve(env.LOG_FILE || `logs/session-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}.jsonl`),
  };
}
