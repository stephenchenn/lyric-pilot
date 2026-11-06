import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface EventLogger {
  log(event: string, data?: Record<string, unknown>): void;
}

const sensitiveKey = /authorization|cookie|password|secret|token|api[-_]?key/i;

export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    return secrets.filter(Boolean).reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, sensitiveKey.test(key) ? "[REDACTED]" : redact(item, secrets),
    ]));
  }
  return value;
}

export function safePath(path: string): string {
  const url = new URL(path, "http://local.invalid");
  for (const key of [...url.searchParams.keys()]) {
    if (sensitiveKey.test(key)) url.searchParams.set(key, "[REDACTED]");
  }
  return url.pathname + url.search;
}

export class JsonlLogger implements EventLogger {
  readonly path: string;
  readonly #secrets: readonly string[];

  constructor(path: string, secrets: readonly string[] = []) {
    this.path = path;
    this.#secrets = secrets;
    mkdirSync(dirname(path), { recursive: true });
    // Fail before starting a session if diagnostic storage is unavailable.
    appendFileSync(path, "", { mode: 0o600 });
  }

  log(event: string, data: Record<string, unknown> = {}): void {
    appendFileSync(this.path, JSON.stringify({
      ...redact(data, this.#secrets) as object, ts: new Date().toISOString(), event,
    }) + "\n");
  }
}
