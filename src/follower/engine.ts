import { normalizeLyrics } from "../lyrics/normalize.ts";
import { LyricMatcher, type Candidate } from "../lyrics/matcher.ts";
import { StructureTracker, type LyricPosition } from "../song/structure.ts";
import type { Song } from "../song/model.ts";
import { DecisionPolicy, type Decision, type PolicySettings } from "../decision/policy.ts";
import { TranscriptBuffer } from "../transcription/buffer.ts";
import type { FollowerEvent, OperatingMode } from "../transcription/types.ts";
import type { EventLogger } from "../logging/logger.ts";
import type { PlannedProgress } from "../lyrics/planned.ts";

export interface FollowerFrame {
  atMs: number;
  inputType: FollowerEvent["type"];
  mode: OperatingMode;
  paused: boolean;
  healthy: boolean;
  inputMessage: string;
  transcript: string;
  tracked: LyricPosition;
  expected: LyricPosition | null;
  displayedSlideId: string;
  deviation: boolean;
  candidates: Candidate[];
  decision: Decision;
  lastAction: string;
  progress?: PlannedProgress;
}
export interface Transition { atMs: number; slideId: string; position: LyricPosition; deviation: boolean; action: "suggest" | "trigger" | "manual" }

/** Simulation-only output. This engine cannot send requests to real ProPresenter. */
export class LyricFollower {
  readonly song: Song;
  readonly tracker: StructureTracker;
  readonly #matcher: LyricMatcher;
  readonly #buffer: TranscriptBuffer;
  readonly #policy: DecisionPolicy;
  readonly #logger: EventLogger;
  readonly transitions: Transition[] = [];
  #mode: OperatingMode;
  #paused = false;
  #healthy = true;
  #inputMessage = "Transcript simulation";
  #displayed: string;
  #lastAt = 0;
  #lastAction = "Session ready; simulated output only";

  constructor(song: Song, logger: EventLogger, options: {
    mode?: OperatingMode; initialSlideId?: string; initialStepIndex?: number;
    windowMs?: number; policy?: Partial<PolicySettings>;
  } = {}) {
    this.song = song;
    this.tracker = new StructureTracker(song, options.initialSlideId, options.initialStepIndex);
    this.#matcher = new LyricMatcher(song);
    this.#buffer = new TranscriptBuffer(options.windowMs);
    this.#policy = new DecisionPolicy(options.policy);
    this.#logger = logger;
    this.#mode = options.mode ?? "ASSIST";
    this.#displayed = this.tracker.current.slideId;
  }

  observe(event: FollowerEvent): FollowerFrame {
    if (!Number.isFinite(event.atMs) || event.atMs < this.#lastAt) throw new Error("Follower events must arrive in nondecreasing availability-time order");
    this.#lastAt = event.atMs;
    let newEvidence = false;
    if (event.type === "transcript") newEvidence = this.#buffer.add(event);
    if (event.type === "manual") {
      this.tracker.reanchor(event.slideId, event.stepIndex);
      this.#displayed = event.slideId;
      this.#buffer.clear(); this.#policy.manual(event.atMs);
      this.#lastAction = `Human selected ${event.slideId}; automation grace period`;
      this.transitions.push({ atMs: event.atMs, slideId: event.slideId, position: this.tracker.current, deviation: false, action: "manual" });
    }
    if (event.type === "mode") {
      if (!["MANUAL", "ASSIST", "AUTO"].includes(event.mode)) throw new Error("Unknown operating mode");
      this.#mode = event.mode;
      this.#buffer.clear(); this.#policy.reset();
      this.#lastAction = `Mode ${event.mode}; waiting for fresh input`;
    }
    if (event.type === "pause") {
      this.#paused = event.paused;
      this.#buffer.clear(); this.#policy.reset();
      this.#lastAction = event.paused ? "Paused" : "Resumed; waiting for fresh input";
    }
    if (event.type === "health") {
      this.#healthy = event.healthy;
      this.#inputMessage = event.message;
      this.#buffer.clear(); this.#policy.reset();
      this.#lastAction = event.healthy ? "Input restored; waiting for fresh evidence" : "Input unavailable; holding simulated output";
    }
    const transcript = this.#buffer.text(event.atMs);
    const candidates = this.#matcher.rank(transcript, this.tracker);
    const decision = this.#policy.decide({
      atMs: event.atMs, mode: this.#mode, paused: this.#paused, healthy: this.#healthy,
      candidates, newEvidence, final: event.type === "transcript" && event.final, displayedSlideId: this.#displayed,
    });
    const top = candidates[0];
    if (decision.accepted && top) {
      const accepted = this.tracker.accept(top.position);
      if (decision.action === "trigger") this.#displayed = top.slideId;
      this.#lastAction = `${decision.action === "trigger" ? "Simulated trigger" : "Suggestion"}: ${top.slideId}${accepted.deviation ? " (deviation)" : ""}`;
      this.transitions.push({ atMs: event.atMs, slideId: top.slideId, position: top.position, deviation: accepted.deviation, action: decision.action as "suggest" | "trigger" });
      this.#policy.reset();
    }
    const frame: FollowerFrame = {
      atMs: event.atMs, inputType: event.type, mode: this.#mode, paused: this.#paused, healthy: this.#healthy, inputMessage: this.#inputMessage,
      transcript, tracked: this.tracker.current, expected: this.tracker.expected,
      displayedSlideId: this.#displayed, deviation: this.tracker.deviation, candidates,
      decision, lastAction: this.#lastAction,
    };
    this.#logger.log("follower_decision", { policyVersion: this.#policy.settings.version, input: event, normalizedTranscript: normalizeLyrics(transcript), ...frame });
    return frame;
  }
}
