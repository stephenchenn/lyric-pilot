import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import type { EventLogger } from "../src/logging/logger.ts";
import { loadProfile } from "../src/propresenter/profile.ts";

export class MemoryLogger implements EventLogger {
  readonly events: { event: string; data: Record<string, unknown> }[] = [];
  log(event: string, data: Record<string, unknown> = {}): void {
    this.events.push({ event, data: structuredClone(data) });
  }
}

export const fixtureProfile = () => loadProfile(new URL("./fixtures/http-profile.json", import.meta.url).pathname);

export async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(error => {
      response.writeHead(500).end(String(error));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export async function presenterFixture() {
  const song = JSON.parse(readFileSync(new URL("../data/songs/synthetic-test/song.json", import.meta.url), "utf8"));
  const state = {
    currentIndex: 0, healthy: true, malformed: false, mismatch: false,
    failTrigger: false, dropTriggerResponse: false, triggerCount: 0, lastBody: null as unknown,
    hasActivePresentation: true,
  };
  const requests: string[] = [];
  const server = await serve(async (request, response) => {
    const path = request.url;
    requests.push(`${request.method} ${path}`);
    response.setHeader("Content-Type", "application/json");
    if (!state.healthy) { response.writeHead(503).end('{"error":"offline"}'); return; }
    if (path === "/fixture/health") { response.end('{"ready":true}'); return; }
    if (path === "/fixture/live/presentation") {
      response.end(JSON.stringify({ data: state.hasActivePresentation ? {
        identity: { uuid: song.presentationId }, name: song.title,
      } : null }));
      return;
    }
    if (path === "/fixture/live/slide") {
      const slide = song.slides[state.currentIndex];
      response.end(JSON.stringify({ data: state.hasActivePresentation ? {
        uuid: slide.id, number: state.malformed ? "not-a-number" : slide.index + 1,
        presentation: { uuid: state.mismatch ? "different-presentation" : song.presentationId },
      } : null }));
      return;
    }
    if (path === `/fixture/presentations/${song.presentationId}/cues`) {
      response.end(JSON.stringify({ result: { cues: song.slides.map((slide: Record<string, unknown>) => ({
        uuid: slide.id, number: Number(slide.index) + 1, lyric: slide.text, group: { name: slide.section },
      })).reverse() } })); // Deliberately out of order to exercise index normalization.
      return;
    }
    const trigger = /^\/fixture\/presentations\/([^/]+)\/cues\/([^/]+)\/fire$/.exec(path ?? "");
    if (trigger && request.method === "POST") {
      state.triggerCount++;
      if (state.failTrigger) { response.writeHead(500).end('{"error":"trigger rejected"}'); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      state.lastBody = JSON.parse(Buffer.concat(chunks).toString());
      const index = song.slides.findIndex((slide: Record<string, unknown>) => slide.id === trigger[2]);
      if (trigger[1] !== song.presentationId || index < 0) { response.writeHead(404).end(); return; }
      state.currentIndex = index;
      if (state.dropTriggerResponse) { request.socket.destroy(); return; }
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end('{"error":"unknown fixture route"}');
  });
  return { ...server, state, requests };
}
