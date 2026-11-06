import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { AcousticObservation } from "../lyrics/planned.ts";
import type { CtcVocabulary } from "../transcription/ctc.ts";
import type { OperatingMode } from "../transcription/types.ts";
import type { Song } from "../song/model.ts";
import type { EventLogger } from "../logging/logger.ts";
import type { FollowerFrame } from "../follower/engine.ts";
import { PlannedFollower } from "../follower/planned.ts";
import { evaluate, parseScenario, type ReplayReport } from "./replay.ts";

export interface PlannedReplay {
  vocabulary: CtcVocabulary;
  observations: (AcousticObservation & { atMs: number })[];
}

export function parsePlannedReplay(value: unknown): PlannedReplay {
  if (!value || typeof value !== "object") throw new Error("Planned replay must be an object");
  const input = value as PlannedReplay;
  if (!input.vocabulary || !Array.isArray(input.vocabulary.labels) || !input.vocabulary.labels.length || !input.vocabulary.labels.every(label => typeof label === "string") || !Number.isInteger(input.vocabulary.blank) || !input.vocabulary.labels[input.vocabulary.blank] || !Array.isArray(input.observations)) throw new Error("Planned replay requires a CTC vocabulary and acoustic observations");
  let lastAt = -1, lastEnd = -1;
  for (const row of input.observations) {
    if (!row || ![row.atMs, row.startMs, row.endMs, row.decodeMs, row.frameStepMs, row.frameOffsetMs].every(Number.isFinite) || row.startMs < 0 || row.endMs < row.startMs || row.endMs < lastEnd || row.atMs < row.endMs || row.atMs < lastAt || row.decodeMs < 0 || row.frameStepMs <= 0 || row.frameOffsetMs < 0 || typeof row.text !== "string" || !Array.isArray(row.logProbs)) throw new Error("Planned replay observations must have valid acoustic and ordered availability times");
    lastAt = row.atMs; lastEnd = row.endMs;
  }
  return input;
}

/** Reuse real model posteriors and measured availability, without loading a model. */
export async function replayPlanned(song: Song, input: PlannedReplay, logger: EventLogger, options: {
  mode?: OperatingMode; speed?: number; signal?: AbortSignal; truthPath?: string;
  onFrame?: (frame: FollowerFrame) => void;
} = {}): Promise<ReplayReport> {
  parsePlannedReplay(input);
  const speed = options.speed ?? 0;
  if (!Number.isFinite(speed) || speed < 0) throw new Error("Replay speed must be nonnegative");
  const engine = new PlannedFollower(song, logger, input.vocabulary, options.mode ?? "AUTO");
  const initialSlideId = engine.tracker.stages[0]!.slideId;
  const frames = [engine.snapshot(0)]; options.onFrame?.(frames[0]!);
  const started = performance.now();
  for (const row of input.observations) {
    options.signal?.throwIfAborted();
    const wait = speed ? row.atMs / speed - (performance.now() - started) : 0;
    if (wait > 0) await delay(wait, undefined, options.signal ? { signal: options.signal } : {});
    const frame = engine.observe(row, row.atMs); frames.push(frame); options.onFrame?.(frame);
  }
  const audioDuration = input.observations.at(-1)?.endMs ?? 0;
  const durationMs = Math.max(1, audioDuration, frames.at(-1)!.atMs);
  // Evaluation annotations are deliberately loaded after all decisions.
  const rawTruth = options.truthPath ? JSON.parse(readFileSync(options.truthPath, "utf8")) : [];
  const annotations = Array.isArray(rawTruth) ? rawTruth : rawTruth.groundTruth;
  const groundTruth = parseScenario({ name: "planned-evaluation", durationMs: Math.max(durationMs, ...annotations.map((point: { atMs: number }) => point.atMs)), events: [], groundTruth: annotations }, song).groundTruth.filter(point => point.atMs <= audioDuration);
  const base = { name: "Planned acoustic replay", initialSlideId, mode: options.mode ?? "AUTO", durationMs, evaluationDurationMs: Math.max(1, audioDuration), frames, transitions: engine.transitions, groundTruth };
  return { ...base, metrics: evaluate(base, initialSlideId) };
}
