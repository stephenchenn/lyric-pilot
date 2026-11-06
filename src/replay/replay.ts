import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { LyricFollower, type FollowerFrame, type Transition } from "../follower/engine.ts";
import type { FollowerEvent, OperatingMode, TranscriptEvent } from "../transcription/types.ts";
import { validateTranscript } from "../transcription/types.ts";
import type { Song } from "../song/model.ts";
import type { EventLogger } from "../logging/logger.ts";

export interface GroundTruthPoint { atMs: number; slideId: string }
export interface ReplayScenario {
  name: string;
  description: string;
  durationMs: number;
  events: FollowerEvent[];
  groundTruth: GroundTruthPoint[];
  transcriptWindowMs?: number;
  evaluationDurationMs?: number;
}
export interface ReplayReport {
  name: string;
  initialSlideId: string;
  mode: OperatingMode;
  durationMs: number;
  evaluationDurationMs: number;
  frames: FollowerFrame[];
  transitions: Transition[];
  groundTruth: GroundTruthPoint[];
  metrics: ReplayMetrics | null;
}
export interface ReplayMetrics {
  transcriptSamples: number;
  top1Accuracy: number | null;
  top3Accuracy: number | null;
  trackingTimeAccuracy: number;
  displayedTimeAccuracy: number;
  expectedTransitions: number;
  matchedTransitions: number;
  missedTransitions: number;
  falseTransitions: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
}

export function parseScenario(value: unknown, song: Song): ReplayScenario {
  if (!value || typeof value !== "object") throw new Error("Replay must be a JSON object");
  const input = value as Record<string, unknown>;
  if (typeof input.name !== "string" || !input.name || !Number.isFinite(input.durationMs) || Number(input.durationMs) <= 0 || !Array.isArray(input.events) || !Array.isArray(input.groundTruth)) {
    throw new Error("Replay requires name, positive durationMs, events and groundTruth arrays");
  }
  const known = new Set(song.slides.map(slide => slide.id));
  let lastAt = -1;
  for (const item of input.events) {
    if (!item || typeof item !== "object" || !Number.isFinite(item.atMs) || item.atMs < 0 || item.atMs < lastAt || item.atMs > Number(input.durationMs)) throw new Error("Replay events must be ordered by availability time and inside durationMs");
    lastAt = item.atMs;
    if (item.type === "transcript") validateTranscript(item as TranscriptEvent);
    else if (item.type === "manual") { if (!known.has(item.slideId)) throw new Error("Unknown manual slide in replay"); }
    else if (item.type === "mode") { if (!["AUTO", "ASSIST", "MANUAL"].includes(item.mode)) throw new Error("Unknown replay mode"); }
    else if (item.type === "pause") { if (typeof item.paused !== "boolean") throw new Error("pause requires paused boolean"); }
    else if (item.type === "health") { if (typeof item.healthy !== "boolean" || typeof item.message !== "string") throw new Error("Invalid health event"); }
    else if (item.type !== "tick") throw new Error(`Unknown replay event type: ${String(item.type)}`);
  }
  lastAt = -1;
  for (const point of input.groundTruth) {
    if (!point || !Number.isFinite(point.atMs) || point.atMs < 0 || point.atMs <= lastAt || point.atMs > Number(input.durationMs) || !known.has(point.slideId)) throw new Error("Ground truth must have strictly increasing times and known slide IDs");
    lastAt = point.atMs;
  }
  if (input.groundTruth.length && input.groundTruth[0].atMs !== 0) throw new Error("Ground truth must start at zero");
  if (input.transcriptWindowMs !== undefined && (typeof input.transcriptWindowMs !== "number" || !Number.isInteger(input.transcriptWindowMs) || input.transcriptWindowMs < 100 || input.transcriptWindowMs > 30_000)) throw new Error("Invalid replay transcriptWindowMs");
  if (input.evaluationDurationMs !== undefined && (typeof input.evaluationDurationMs !== "number" || !Number.isFinite(input.evaluationDurationMs) || input.evaluationDurationMs <= 0 || input.evaluationDurationMs > Number(input.durationMs))) throw new Error("Invalid evaluationDurationMs");
  return {
    name: input.name, description: typeof input.description === "string" ? input.description : "Imported transcript replay",
    durationMs: Number(input.durationMs), events: input.events as FollowerEvent[], groundTruth: input.groundTruth as GroundTruthPoint[],
    ...(input.transcriptWindowMs !== undefined ? { transcriptWindowMs: input.transcriptWindowMs as number } : {}),
    ...(input.evaluationDurationMs !== undefined ? { evaluationDurationMs: input.evaluationDurationMs as number } : {}),
  };
}

export const loadScenario = (path: string, song: Song): ReplayScenario => parseScenario(JSON.parse(readFileSync(path, "utf8")), song);

export function truthAt(truth: GroundTruthPoint[], atMs: number): string | null {
  return truth.findLast(point => point.atMs <= atMs)?.slideId ?? null;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function evaluate(report: Omit<ReplayReport, "metrics">, initialSlideId: string): ReplayMetrics | null {
  if (!report.groundTruth.length) return null;
  const { groundTruth, frames, transitions } = report;
  const durationMs = report.evaluationDurationMs;
  // Frames correspond one-for-one to replay input events; empty/expired buffers
  // are excluded from lexical ranking accuracy but included in time accuracy.
  const samples = frames.filter(frame => frame.atMs <= durationMs && frame.inputType === "transcript" && frame.transcript.trim() && frame.candidates[0]?.audio);
  const correct = (top: number) => samples.filter(frame => frame.candidates.slice(0, top).some(candidate => candidate.slideId === truthAt(groundTruth, frame.atMs))).length;
  const breakpoints = [...new Set([0, durationMs, ...groundTruth.map(point => point.atMs).filter(time => time <= durationMs), ...frames.map(frame => frame.atMs).filter(time => time <= durationMs)])].sort((a, b) => a - b);
  let trackingCorrect = 0, displayedCorrect = 0;
  for (let index = 0; index < breakpoints.length - 1; index++) {
    const start = breakpoints[index]!, end = breakpoints[index + 1]!;
    const frame = frames.findLast(frame => frame.atMs <= start);
    const truth = truthAt(groundTruth, start);
    if ((frame?.tracked.slideId ?? initialSlideId) === truth) trackingCorrect += end - start;
    if ((frame?.displayedSlideId ?? initialSlideId) === truth) displayedCorrect += end - start;
  }
  const expected = groundTruth.filter((point, index) => index > 0 && point.atMs < durationMs && point.slideId !== groundTruth[index - 1]!.slideId);
  const used = new Set<number>();
  const latencies: number[] = [];
  for (const point of expected) {
    const next = Math.min(groundTruth.find(next => next.atMs > point.atMs)?.atMs ?? durationMs, durationMs);
    const index = transitions.findIndex((transition, index) => !used.has(index) && transition.slideId === point.slideId && transition.atMs >= point.atMs && transition.atMs < next);
    if (index >= 0) { used.add(index); latencies.push(transitions[index]!.atMs - point.atMs); }
  }
  return {
    transcriptSamples: samples.length, top1Accuracy: frames.some(frame => frame.progress) ? null : samples.length ? correct(1) / samples.length : 0,
    top3Accuracy: frames.some(frame => frame.progress) ? null : samples.length ? correct(3) / samples.length : 0,
    trackingTimeAccuracy: trackingCorrect / durationMs, displayedTimeAccuracy: displayedCorrect / durationMs,
    expectedTransitions: expected.length, matchedTransitions: used.size, missedTransitions: expected.length - used.size,
    falseTransitions: transitions.filter((transition, index) => !used.has(index) && transition.action !== "manual").length,
    medianLatencyMs: percentile(latencies, 0.5), p95LatencyMs: percentile(latencies, 0.95),
  };
}

export async function replay(song: Song, scenario: ReplayScenario, logger: EventLogger, options: {
  mode?: OperatingMode; speed?: number; signal?: AbortSignal; onFrame?: (frame: FollowerFrame) => void;
} = {}): Promise<ReplayReport> {
  const speed = options.speed ?? 0;
  if (!Number.isFinite(speed) || speed < 0) throw new Error("Replay speed must be nonnegative (0 = immediate)");
  const engine = new LyricFollower(song, logger, { mode: options.mode ?? "AUTO", ...(scenario.transcriptWindowMs ? { windowMs: scenario.transcriptWindowMs } : {}) });
  const initial = engine.tracker.current.slideId;
  const frames: FollowerFrame[] = [];
  const started = performance.now();
  for (const event of scenario.events) {
    options.signal?.throwIfAborted();
    const wait = speed ? event.atMs / speed - (performance.now() - started) : 0;
    if (wait > 0) await delay(wait, undefined, options.signal ? { signal: options.signal } : {});
    const frame = engine.observe(event);
    frames.push(frame);
    options.onFrame?.(frame);
  }
  const end = engine.observe({ type: "tick", atMs: scenario.durationMs });
  frames.push(end);
  const result = { name: scenario.name, initialSlideId: initial, mode: options.mode ?? "AUTO", durationMs: scenario.durationMs, evaluationDurationMs: scenario.evaluationDurationMs ?? scenario.durationMs, frames, transitions: engine.transitions, groundTruth: scenario.groundTruth };
  return { ...result, metrics: evaluate(result, initial) };
}
