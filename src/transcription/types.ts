export interface RecognizedWord { text: string; startMs: number; endMs: number }
export interface TranscriptEvent {
  type: "transcript";
  id: string;
  startMs: number;
  endMs: number;
  /** When the result became available, never a backdated acoustic timestamp. */
  atMs: number;
  text: string;
  final: boolean;
  words?: RecognizedWord[];
  providerConfidence?: number;
}
export type OperatingMode = "MANUAL" | "ASSIST" | "AUTO";
export type FollowerEvent = TranscriptEvent
  | { type: "tick"; atMs: number }
  | { type: "manual"; atMs: number; slideId: string; stepIndex?: number }
  | { type: "mode"; atMs: number; mode: OperatingMode }
  | { type: "pause"; atMs: number; paused: boolean }
  | { type: "health"; atMs: number; healthy: boolean; message: string };

export function validateTranscript(event: TranscriptEvent): void {
  if (!event.id || typeof event.text !== "string" || typeof event.final !== "boolean" ||
      ![event.startMs, event.endMs, event.atMs].every(value => Number.isFinite(value) && value >= 0) ||
      event.startMs > event.endMs || event.endMs > event.atMs) throw new Error("Invalid transcript timestamps/fields; results cannot arrive before their audio ends");
  if (event.providerConfidence !== undefined && (!Number.isFinite(event.providerConfidence) || event.providerConfidence < 0 || event.providerConfidence > 1)) {
    throw new Error("Provider confidence must be between 0 and 1");
  }
  if (event.words?.some(word => typeof word.text !== "string" || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) ||
    word.startMs < event.startMs || word.endMs > event.endMs || word.startMs > word.endMs)) throw new Error("Invalid recognized word timestamps");
}
