import { randomUUID } from "node:crypto";
import { errorMessage } from "./adapter.ts";
import { assertRelativePath } from "./profile.ts";
import { safePath, type EventLogger } from "../logging/logger.ts";

export interface HttpResult { status: number; body: unknown }

export class HttpClient {
  readonly #baseUrl: URL;
  readonly #timeoutMs: number;
  readonly #logger: EventLogger;
  readonly #token: string | undefined;

  constructor(baseUrl: string, timeoutMs: number, logger: EventLogger, token?: string) {
    this.#baseUrl = new URL(baseUrl);
    if (!["http:", "https:"].includes(this.#baseUrl.protocol) || this.#baseUrl.username || this.#baseUrl.password) {
      throw new Error("ProPresenter URL must be HTTP(S) without embedded credentials");
    }
    this.#timeoutMs = timeoutMs;
    this.#logger = logger;
    this.#token = token;
  }

  /** Exactly one attempt. GET can also be a control operation in the vendor API. */
  async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<HttpResult> {
    assertRelativePath(path);
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) throw new Error("Cross-origin request rejected");
    const requestId = randomUUID();
    const started = performance.now();
    const safe = safePath(path);
    this.#logger.log("http_request", { requestId, method, path: safe, ...(body !== undefined ? { body } : {}) });
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json, text/plain, text/html",
          ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
        redirect: "manual",
      });
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 1_048_576) throw new Error("Response exceeds 1 MiB; inspect the endpoint/profile");
          chunks.push(chunk);
        }
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      let result: unknown = raw || null;
      if (raw) {
        try { result = JSON.parse(raw); } catch { /* Explorer also supports documentation HTML. */ }
      }
      this.#logger.log("http_response", {
        requestId, method, path: safe, status: response.status,
        durationMs: Math.round(performance.now() - started), body: result,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}; see the logged response`);
      return { status: response.status, body: result };
    } catch (error) {
      const detail = errorMessage(error);
      const message = `${method} ${safe}: ${detail}`;
      this.#logger.log("http_error", { requestId, method, path: safe, message, durationMs: Math.round(performance.now() - started) });
      throw new Error(message);
    }
  }
}
