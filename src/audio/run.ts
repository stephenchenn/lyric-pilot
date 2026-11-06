import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Song } from "../song/model.ts";
import type { EventLogger } from "../logging/logger.ts";
import { LyricFollower, type FollowerFrame } from "../follower/engine.ts";
import type { FollowerEvent, OperatingMode } from "../transcription/types.ts";
import { WhisperCppTranscriber, type WindowTranscriber } from "../transcription/whisper.ts";
import { transcribeWindows } from "../transcription/pipeline.ts";
import { capturePcm } from "./source.ts";
import { rollingWindows } from "./pcm.ts";
import { evaluate, parseScenario, type GroundTruthPoint, type ReplayReport, type ReplayScenario } from "../replay/replay.ts";
import { renderTimeline } from "../replay/timeline.ts";

export interface AudioRunResult {
  report: ReplayReport;
  scenario: ReplayScenario;
  settings: { provider: Record<string, string | number>; windowMs: number; stepMs: number; realtime: boolean };
  timing: {
    audioDurationMs: number; decodingMs: number; processingWallMs: number;
    windowCount: number; silenceWindows: number; maximumBacklogMs: number; decodeToAudioRatio: number;
  };
}

export async function runAudio(song: Song, logger: EventLogger, input: { file: string } | { device: string }, options: {
  mode?: OperatingMode; windowMs?: number; stepMs?: number; realtime?: boolean; signal?: AbortSignal;
  truthPath?: string; transcriber?: WindowTranscriber; onFrame?: (frame: FollowerFrame) => void;
  onTranscript?: (event: FollowerEvent) => void;
} = {}): Promise<AudioRunResult> {
  const engine = new LyricFollower(song, logger, { mode: options.mode ?? "ASSIST", windowMs: options.windowMs ?? 5000 });
  const initialSlideId = engine.tracker.current.slideId;
  const frames: FollowerFrame[] = [], events: FollowerEvent[] = [];
  const transcriber = options.transcriber ?? new WhisperCppTranscriber();
  const settings = {
    provider: transcriber.metadata ?? { provider: "custom" }, windowMs: options.windowMs ?? 5000,
    stepMs: options.stepMs ?? 1500, realtime: options.realtime ?? !("file" in input),
  };
  logger.log("audio_started", { settings, mode: options.mode ?? "ASSIST" });
  const started = performance.now();
  const timing = { audioDurationMs: 0, decodingMs: 0, processingWallMs: 0, windowCount: 0, silenceWindows: 0, maximumBacklogMs: 0, decodeToAudioRatio: 0 };
  const observe = (event: FollowerEvent) => {
    events.push(event);
    const frame = engine.observe(event);
    frames.push(frame);
    options.onTranscript?.(event);
    options.onFrame?.(frame);
  };
  observe({ type: "health", atMs: 0, healthy: true, message: `Local Whisper; ${"file" in input ? "recorded audio" : "microphone"}` });
  try {
    const windows = rollingWindows(capturePcm(input, options.signal), {
      windowMs: options.windowMs ?? 5000, stepMs: options.stepMs ?? 1500,
    });
    for await (const event of transcribeWindows(windows, transcriber, {
      ...(options.signal ? { signal: options.signal } : {}), realtime: options.realtime ?? !("file" in input),
      onWindow: (window, result, availableAtMs) => {
        timing.audioDurationMs = window.endMs;
        timing.decodingMs += result.decodeMs;
        timing.windowCount++;
        if (result.silence) timing.silenceWindows++;
        timing.maximumBacklogMs = Math.max(timing.maximumBacklogMs, availableAtMs - window.endMs);
        logger.log("audio_window", { startMs: window.startMs, endMs: window.endMs, rms: window.rms, decodeMs: result.decodeMs, availableAtMs, silence: result.silence });
      },
    })) observe(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    observe({ type: "health", atMs: events.at(-1)?.atMs ?? 0, healthy: false, message });
    logger.log("audio_failed", { message, timing });
    // The caller receives partial diagnostics, but a failure still has a failing exit code.
    if (!options.signal?.aborted) throw Object.assign(new Error(message), { partialFrames: frames });
  }
  timing.processingWallMs = Math.round(performance.now() - started);
  timing.decodeToAudioRatio = timing.audioDurationMs ? timing.decodingMs / timing.audioDurationMs : 0;
  const durationMs = Math.max(timing.audioDurationMs, events.at(-1)?.atMs ?? 0, 1);
  let groundTruth: GroundTruthPoint[] = [];
  if (options.truthPath) {
    const value = JSON.parse(readFileSync(options.truthPath, "utf8"));
    groundTruth = Array.isArray(value) ? value : value.groundTruth;
  }
  const name = "file" in input ? input.file.split(/[\\/]/).at(-1)! : `microphone-${input.device}`;
  const evaluationDurationMs = Math.max(1, timing.audioDurationMs);
  const scenario = parseScenario({ name, description: "Measured local Whisper rolling-window transcription; not a supplied lyric transcript", durationMs, evaluationDurationMs, events, groundTruth, transcriptWindowMs: options.windowMs ?? 5000 }, song);
  const base = { name, initialSlideId, mode: options.mode ?? "ASSIST", durationMs, evaluationDurationMs, frames, transitions: engine.transitions, groundTruth };
  const report = { ...base, metrics: evaluate(base, initialSlideId) };
  return { report, scenario, settings, timing };
}

export function saveAudioRun(result: AudioRunResult, directory: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "transcript-replay.json"), JSON.stringify(result.scenario, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(resolve(directory, "report.json"), JSON.stringify({ ...result.report, settings: result.settings, timing: result.timing }, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(resolve(directory, "timeline.svg"), renderTimeline(result.report), { mode: 0o600 });
}
