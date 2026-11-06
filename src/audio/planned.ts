import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Song } from "../song/model.ts";
import type { EventLogger } from "../logging/logger.ts";
import type { OperatingMode } from "../transcription/types.ts";
import { CtcTranscriber, type CtcVocabulary, type AcousticTranscriber, type AcousticProfile } from "../transcription/ctc.ts";
import { plannedAlignmentVersion, type AcousticObservation } from "../lyrics/planned.ts";
import { PlannedFollower } from "../follower/planned.ts";
import type { FollowerFrame } from "../follower/engine.ts";
import { parseScenario, evaluate, type ReplayReport } from "../replay/replay.ts";
import { renderTimeline } from "../replay/timeline.ts";
import { capturePcm } from "./source.ts";
import { rollingWindows } from "./pcm.ts";
import type { AudioRunResult } from "./run.ts";

export interface PlannedAudioRunResult {
  report: ReplayReport;
  observations: (AcousticObservation & { atMs: number })[];
  vocabulary: CtcVocabulary;
  settings: { strategy: string; model: string; windowMs: number; stepMs: number; realtime: boolean };
  timing: AudioRunResult["timing"];
}

export async function runPlannedAudio(song: Song, logger: EventLogger, input: { file: string } | { device: string }, options: {
  mode?: OperatingMode; windowMs?: number; stepMs?: number; realtime?: boolean; signal?: AbortSignal;
  truthPath?: string; onFrame?: (frame: FollowerFrame) => void; onReady?: () => void;
  transcriber?: AcousticTranscriber;
  acousticModel?: AcousticProfile;
} = {}): Promise<PlannedAudioRunResult> {
  const transcriber = options.transcriber ?? new CtcTranscriber(options.acousticModel ? { profile: options.acousticModel } : {});
  try {
    const vocabulary = await transcriber.ready();
    options.signal?.throwIfAborted();
    const engine = new PlannedFollower(song, logger, vocabulary, options.mode ?? "ASSIST");
    const settings = { strategy: plannedAlignmentVersion, model: vocabulary.model ? `CTC ${vocabulary.model.backend ?? "provider"}: ${vocabulary.model.path}` : "custom CTC provider", ...(vocabulary.model ? { modelSha256: vocabulary.model.sha256 } : {}), windowMs: options.windowMs ?? 1500, stepMs: options.stepMs ?? 500, realtime: options.realtime ?? !("file" in input) };
    const observations: PlannedAudioRunResult["observations"] = [], frames: FollowerFrame[] = [];
    const initialSlideId = engine.tracker.stages[0]!.slideId;
    const timing = { audioDurationMs: 0, decodingMs: 0, processingWallMs: 0, windowCount: 0, silenceWindows: 0, maximumBacklogMs: 0, decodeToAudioRatio: 0 };
    logger.log("planned_audio_started", { settings, mode: options.mode ?? "ASSIST" });
    options.onReady?.();
    const started = performance.now();
    const initial = engine.snapshot(0); frames.push(initial); options.onFrame?.(initial);
    let previousAvailability = 0;
    try {
      const windows = rollingWindows(capturePcm(input, options.signal), { windowMs: settings.windowMs, stepMs: settings.stepMs });
      for await (const window of windows) {
        options.signal?.throwIfAborted();
        if (settings.realtime) {
          const wait = window.endMs - (performance.now() - started);
          if (wait > 0) await delay(wait, undefined, options.signal ? { signal: options.signal } : {});
        }
        const result = await transcriber.transcribe(window, options.signal);
        const nominal = Math.max(window.endMs, previousAvailability) + result.decodeMs;
        const atMs = settings.realtime ? Math.max(nominal, Math.round(performance.now() - started)) : nominal;
        previousAvailability = atMs;
        observations.push({ ...result, atMs });
        timing.audioDurationMs = window.endMs; timing.decodingMs += result.decodeMs; timing.windowCount++;
        if (window.rms < 0.006) timing.silenceWindows++;
        timing.maximumBacklogMs = Math.max(timing.maximumBacklogMs, atMs - window.endMs);
        const frame = engine.observe(result, atMs); frames.push(frame); options.onFrame?.(frame);
      }
    } catch (error) {
      if (!options.signal?.aborted) throw error;
    }
    timing.processingWallMs = Math.round(performance.now() - started);
    timing.decodeToAudioRatio = timing.audioDurationMs ? timing.decodingMs / timing.audioDurationMs : 0;
    // Read annotations only after following has finished. They never enter alignment.
    const rawTruth = options.truthPath ? JSON.parse(readFileSync(options.truthPath, "utf8")) : [];
    const durationMs = Math.max(timing.audioDurationMs, previousAvailability, 1);
    const annotations = Array.isArray(rawTruth) ? rawTruth : rawTruth.groundTruth;
    const validated = parseScenario({ name: "planned-evaluation", durationMs: Math.max(durationMs, ...annotations.map((point: { atMs: number }) => point.atMs)), events: [], groundTruth: annotations }, song).groundTruth;
    const groundTruth = validated.filter(point => point.atMs <= timing.audioDurationMs);
    const base = { name: "file" in input ? input.file.split(/[\\/]/).at(-1)! : `microphone-${input.device}`, initialSlideId, mode: options.mode ?? "ASSIST", durationMs, evaluationDurationMs: Math.max(1, timing.audioDurationMs), frames, transitions: engine.transitions, groundTruth };
    return { report: { ...base, metrics: evaluate(base, initialSlideId) }, observations, vocabulary, settings, timing };
  } finally { transcriber.close(); }
}

export function savePlannedRun(result: PlannedAudioRunResult, directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "report.json"), JSON.stringify({ ...result.report, settings: result.settings, timing: result.timing }, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(resolve(directory, "guided-replay.json"), JSON.stringify({ vocabulary: result.vocabulary, settings: result.settings, observations: result.observations }) + "\n", { mode: 0o600 });
  writeFileSync(resolve(directory, "timeline.svg"), renderTimeline(result.report), { mode: 0o600 });
}
