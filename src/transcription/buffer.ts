import { validateTranscript, type TranscriptEvent } from "./types.ts";

export class TranscriptBuffer {
  readonly windowMs: number;
  readonly #events = new Map<string, TranscriptEvent>();
  constructor(windowMs = 3500) {
    if (!Number.isFinite(windowMs) || windowMs < 100 || windowMs > 30_000) throw new Error("Transcript window must be 100–30000 ms");
    this.windowMs = windowMs;
  }

  add(event: TranscriptEvent): boolean {
    validateTranscript(event);
    const previous = this.#events.get(event.id);
    if (previous && (previous.atMs > event.atMs || (previous.final && !event.final))) return false;
    const unchanged = previous && JSON.stringify({ ...previous, atMs: 0 }) === JSON.stringify({ ...event, atMs: 0 });
    if (unchanged) return false;
    this.#events.set(event.id, structuredClone(event));
    return true;
  }

  text(atMs: number): string {
    const cutoff = atMs - this.windowMs;
    for (const [id, event] of this.#events) if (event.endMs < cutoff) this.#events.delete(id);
    const events = [...this.#events.values()].filter(event => event.atMs <= atMs).sort((a, b) => a.startMs - b.startMs || a.atMs - b.atMs);
    return events.map(event => {
      if (event.words) return event.words.filter(word => word.endMs >= cutoff).map(word => word.text).join(" ");
      // Saved transcript events without word timings retain their full phrase until expiry.
      return event.text;
    }).join(" ").trim();
  }
  clear(): void { this.#events.clear(); }
}
