import type { Candidate } from "../lyrics/matcher.ts";
import type { OperatingMode } from "../transcription/types.ts";

export const DEFAULT_POLICY = Object.freeze({
  version: "heuristic-v2",
  minimumMargin: 0.08,
  expectedAudio: 0.8,
  expectedScore: 0.84,
  expectedWords: 3,
  unexpectedAudio: 0.90,
  unexpectedScore: 0.76,
  unexpectedWords: 4,
  stableExpectedMs: 200,
  stableUnexpectedMs: 600,
  minimumDwellMs: 500,
  manualCooldownMs: 2000,
});
export type PolicySettings = { [K in keyof typeof DEFAULT_POLICY]: typeof DEFAULT_POLICY[K] extends number ? number : string };
export interface Decision {
  action: "hold" | "suggest" | "trigger";
  accepted: boolean;
  reason: string;
  margin: number;
  stableForMs: number;
  stableUpdates: number;
}

export class DecisionPolicy {
  readonly settings: PolicySettings;
  #winner: string | null = null;
  #since = 0;
  #updates = 0;
  #lastAcceptedAt = -Infinity;
  #cooldownUntil = -Infinity;

  constructor(settings: Partial<PolicySettings> = {}) {
    this.settings = { ...DEFAULT_POLICY, ...settings };
    for (const [key, value] of Object.entries(this.settings)) {
      if (key === "version") continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid policy setting: ${key}`);
    }
  }
  reset(): void { this.#winner = null; this.#updates = 0; }
  manual(atMs: number): void { this.reset(); this.#cooldownUntil = atMs + this.settings.manualCooldownMs; this.#lastAcceptedAt = atMs; }

  decide(input: {
    atMs: number; mode: OperatingMode; paused: boolean; healthy: boolean;
    candidates: Candidate[]; newEvidence: boolean; final: boolean; displayedSlideId: string;
  }): Decision {
    const { atMs, candidates } = input;
    const top = candidates[0];
    const margin = top ? top.score - (candidates[1]?.score ?? 0) : 0;
    const hold = (reason: string): Decision => ({ action: "hold", accepted: false, reason, margin, stableForMs: this.#winner === top?.slideId ? atMs - this.#since : 0, stableUpdates: this.#updates });
    if (input.paused || !input.healthy || input.mode === "MANUAL") {
      this.reset();
      return hold(input.paused ? "paused" : !input.healthy ? "input unavailable" : "manual mode");
    }
    if (!top || top.audio === 0) { this.reset(); return hold("no lyric evidence"); }
    if (atMs < this.#cooldownUntil) { this.reset(); return hold("manual override cooldown"); }
    // A weak but unique partial can establish persistence. It cannot trigger;
    // the current update must still pass the full lexical gate below.
    if (input.newEvidence && top.audio >= 0.65 && top.matchedWords >= 3 && margin >= this.settings.minimumMargin) {
      if (this.#winner !== top.slideId) { this.#winner = top.slideId; this.#since = atMs; this.#updates = 0; }
      this.#updates++;
    } else if (input.newEvidence) this.reset();
    const expected = top.expected || top.current;
    const minAudio = expected ? this.settings.expectedAudio : this.settings.unexpectedAudio;
    const minScore = expected ? this.settings.expectedScore : this.settings.unexpectedScore;
    const minWords = expected ? this.settings.expectedWords : this.settings.unexpectedWords;
    const uniquelyDistinctive = !expected && top.matchedWords >= 3 && top.audio >= 0.98 && margin >= 0.25;
    if (top.audio < minAudio || top.score < minScore || (top.matchedWords < minWords && !uniquelyDistinctive)) {
      return hold("insufficient lexical evidence");
    }
    if (margin < this.settings.minimumMargin) { this.reset(); return hold("ambiguous candidates"); }
    if (top.current && (input.mode !== "AUTO" || top.slideId === input.displayedSlideId)) { this.reset(); return hold("already tracking this slide"); }
    if (!input.newEvidence) return hold("waiting for fresh evidence");
    const stableForMs = atMs - this.#since;
    const distinctiveFinal = expected && input.final && top.matchedWords >= 4 && margin >= 0.12;
    const distinctiveExpectedPartial = top.expected && top.audio >= 0.98 && top.matchedWords >= 4 && margin >= 0.20;
    // An expected phrase can be unmistakable despite a substituted preposition.
    // Require three different, exactly heard content words and a large lead;
    // shared filler, fuzzy words and off-plan candidates do not get this bypass.
    const distinctiveExpectedContent = top.expected && top.audio >= 0.90 && top.exactContentWords.length >= 3 && margin >= 0.25;
    const minimumStableMs = expected ? this.settings.stableExpectedMs : this.settings.stableUnexpectedMs;
    if (!distinctiveFinal && !distinctiveExpectedPartial && !distinctiveExpectedContent && (this.#updates < 2 || stableForMs < minimumStableMs)) return hold("building stable evidence");
    if (atMs - this.#lastAcceptedAt < this.settings.minimumDwellMs) return hold("minimum slide dwell");
    this.#lastAcceptedAt = atMs;
    return {
      action: input.mode === "AUTO" ? "trigger" : "suggest", accepted: true,
      reason: distinctiveExpectedContent ? "distinctive planned phrase" : expected ? "stable planned/current match" : "strong sustained audio overrides arrangement",
      margin, stableForMs, stableUpdates: this.#updates,
    };
  }
}
