import type { Song } from "../song/model.ts";
import type { EventLogger } from "../logging/logger.ts";
import type { OperatingMode } from "../transcription/types.ts";
import { plannedAlignmentVersion, PlannedWordTracker, type AcousticObservation, type PlannedProgress } from "../lyrics/planned.ts";
import type { CtcVocabulary } from "../transcription/ctc.ts";
import type { FollowerFrame, Transition } from "./engine.ts";

/** A fixed-plan follower; timing annotations are deliberately not an input. */
export class PlannedFollower {
  readonly tracker: PlannedWordTracker;
  readonly transitions: Transition[] = [];
  readonly #song: Song;
  readonly #logger: EventLogger;
  readonly #mode: OperatingMode;
  #displayed: string;
  #transcript = "";
  #lastAtMs = 0;

  constructor(song: Song, logger: EventLogger, vocabulary: CtcVocabulary, mode: OperatingMode = "ASSIST") {
    this.#song = song; this.#logger = logger; this.#mode = mode;
    this.tracker = new PlannedWordTracker(song, vocabulary.labels, vocabulary.blank);
    this.#displayed = this.tracker.stages[0]!.slideId;
  }

  observe(observation: AcousticObservation, atMs: number): FollowerFrame {
    if (!Number.isFinite(atMs) || atMs < observation.endMs || atMs < this.#lastAtMs) throw new Error("Invalid acoustic availability timestamp");
    const previous = this.tracker.stageIndex;
    const progress = this.#mode === "MANUAL" ? this.tracker.progress(observation.endMs) : this.tracker.update(observation);
    this.#transcript = observation.text;
    const changed = progress.stageIndex !== previous;
    if (changed && this.#mode === "AUTO") this.#displayed = this.tracker.stages[progress.stageIndex]!.slideId;
    const frame = this.#frame(atMs, progress, changed);
    if (changed) this.transitions.push({ atMs, slideId: frame.tracked.slideId, position: frame.tracked, deviation: false, action: this.#mode === "AUTO" ? "trigger" : "suggest" });
    this.#logger.log("planned_word_progress", { alignmentVersion: plannedAlignmentVersion, ...frame });
    return frame;
  }

  snapshot(atMs: number): FollowerFrame { return this.#frame(atMs, this.tracker.progress(this.#lastAtMs), false); }

  #frame(atMs: number, progress: PlannedProgress, changed: boolean): FollowerFrame {
    this.#lastAtMs = atMs;
    const position = (index: number) => {
      const stage = this.tracker.stages[index]!;
      const section = this.#song.sections.find(section => section.id === stage.sectionId)!;
      return { slideId: stage.slideId, sectionId: stage.sectionId, sectionSlideIndex: section.slideIds.indexOf(stage.slideId), stepIndex: stage.stepIndex, occurrence: stage.occurrence, extraRepeat: 0 };
    };
    const action = changed ? this.#mode === "AUTO" ? "trigger" : "suggest" : "hold";
    return {
      atMs, inputType: "transcript", mode: this.#mode, paused: false, healthy: true,
      inputMessage: "Local acoustic CTC; fixed lyric plan", transcript: this.#transcript,
      tracked: position(progress.stageIndex), expected: this.tracker.stages[progress.stageIndex + 1] ? position(progress.stageIndex + 1) : null,
      displayedSlideId: this.#displayed, deviation: false, candidates: [], progress,
      decision: { action, accepted: changed, reason: changed ? "acoustic words support the next planned slide" : this.#mode === "MANUAL" ? "manual mode" : "following planned words; waiting for acoustic evidence", margin: 0, stableForMs: 0, stableUpdates: 0 },
      lastAction: changed ? `${this.#mode === "AUTO" ? "Simulated trigger" : "Suggestion"}: ${this.tracker.stages[progress.stageIndex]!.slideId}` : "Following fixed lyric plan",
    };
  }
}
