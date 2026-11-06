import { setTimeout as delay } from "node:timers/promises";
import type { AudioWindow } from "../audio/pcm.ts";
import type { TranscriptEvent } from "./types.ts";
import type { Transcription, WindowTranscriber } from "./whisper.ts";

/** Causal windowed inference: a window contains no samples after its endMs.
 * Availability timestamps include decode time and backlog, also in accelerated mode.
 */
export async function* transcribeWindows(windows: AsyncIterable<AudioWindow>, transcriber: WindowTranscriber, options: {
  signal?: AbortSignal; realtime?: boolean; onWindow?: (window: AudioWindow, result: Transcription, availableAtMs: number) => void;
} = {}): AsyncGenerator<TranscriptEvent> {
  const started = performance.now();
  let previousAvailability = 0;
  let lastEvent: TranscriptEvent | null = null;
  for await (const window of windows) {
    options.signal?.throwIfAborted();
    if (options.realtime) {
      const wait = window.endMs - (performance.now() - started);
      if (wait > 0) await delay(wait, undefined, options.signal ? { signal: options.signal } : {});
    }
    const result = await transcriber.transcribe(window, options.signal);
    const atMs = Math.max(window.endMs, previousAvailability) + result.decodeMs;
    const availableAtMs = options.realtime ? Math.max(atMs, Math.round(performance.now() - started)) : atMs;
    previousAvailability = availableAtMs;
    options.onWindow?.(window, result, availableAtMs);
    lastEvent = {
      type: "transcript", id: "rolling-audio", startMs: window.startMs, endMs: window.endMs,
      atMs: availableAtMs, text: result.text, words: result.words,
      // Sliding windows revise the current hypothesis. A last short tail is final.
      final: window.final,
    };
    yield lastEvent;
  }
  // Finalize an exact-boundary stream at EOF without decoding it twice.
  if (lastEvent && !lastEvent.final) yield { ...lastEvent, final: true };
}
