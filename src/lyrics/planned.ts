import type { Song } from "../song/model.ts";

export const plannedAlignmentVersion = "ctc-plan-v2";

export interface AcousticObservation {
  startMs: number; endMs: number; frameOffsetMs: number; frameStepMs: number;
  logProbs: number[][]; text: string; decodeMs: number;
}
export interface PlannedStage {
  slideId: string; sectionId: string; stepIndex: number; occurrence: number;
  startWord: number; endWord: number;
}
export interface PlannedWordEvidence {
  text: string; status: "heard" | "uncertain" | "pending";
  confidence: number | null; startMs: number | null; endMs: number | null;
}
export interface PlannedProgress {
  stageIndex: number; words: PlannedWordEvidence[]; heardWords: number;
  totalWords: number; nextWord: string | null; acousticEndMs: number;
}

const functionWords = new Set("a an and are as at be by for from he her his i in is it its me my of on or our she that the their them they this to was we were with you your".split(" "));
const phraseWords = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").replaceAll("’", "'").match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) ?? [];

/** Online CTC alignment to one fixed arrangement. No slide search or clock plan.
 * Skipped/weak words stay uncertain; only acoustic support marks a word heard.
 */
export class PlannedWordTracker {
  readonly stages: PlannedStage[] = [];
  readonly #words: { text: string; stage: number; start: number; end: number }[] = [];
  readonly #tokens: number[] = [];
  readonly #skip = new Map<number, number>();
  readonly #proof = new Map<number, PlannedWordEvidence>();
  readonly #labels: string[];
  readonly #blank: number;
  readonly #missingWordPenalty: number;
  readonly #history: { back: Uint16Array; probabilities: number[]; atMs: number; scores: Float64Array; scoreStart: number }[] = [];
  #scores: Float64Array;
  #lastFrameMs = -1;
  #lockedWord = -1;
  #floor = 0;
  #stage = 0;
  #retiredMs = -1;
  #latestEndMs = 0;

  constructor(song: Song, labels: string[], blank = 0, options: { missingWordPenalty?: number } = {}) {
    if (!labels.length || labels.indexOf("|") < 0 || !Number.isInteger(blank) || !labels[blank]) throw new Error("Invalid CTC vocabulary");
    this.#labels = labels; this.#blank = blank;
    this.#missingWordPenalty = options.missingWordPenalty ?? 3;
    if (!Number.isFinite(this.#missingWordPenalty) || this.#missingWordPenalty <= 0) throw new Error("Missing-word penalty must be positive");
    for (const [stepIndex, step] of song.arrangement.entries()) {
      const section = song.sections.find(section => section.id === step.sectionId)!;
      for (const slideId of section.slideIds) {
        const slide = song.slides.find(slide => slide.id === slideId)!;
        const stageIndex = this.stages.length, startWord = this.#words.length;
        for (const text of phraseWords(slide.text)) {
          const start = this.#tokens.length;
          for (const character of `${text.toUpperCase()}|`) {
            const id = labels.findIndex(label => label.toUpperCase() === character);
            if (id < 0) throw new Error(`Planned acoustic model does not support character ${character}`);
            this.#tokens.push(id);
          }
          const end = this.#tokens.length - 1;
          this.#words.push({ text, stage: stageIndex, start, end });
          this.#skip.set(2 * (end + 1), 2 * start);
        }
        if (startWord === this.#words.length) throw new Error("Planned acoustic tracking requires lyric words on every slide");
        this.stages.push({ slideId, sectionId: section.id, stepIndex, occurrence: step.occurrence, startWord, endWord: this.#words.length });
      }
    }
    this.#scores = new Float64Array(2 * this.#tokens.length + 1).fill(-Infinity);
    this.#scores[0] = 0;
  }

  get stageIndex(): number { return this.#stage; }

  update(observation: AcousticObservation): PlannedProgress {
    if (![observation.startMs, observation.endMs, observation.frameOffsetMs, observation.frameStepMs].every(Number.isFinite) || observation.startMs < 0 || observation.endMs < observation.startMs || observation.frameOffsetMs < 0 || observation.frameStepMs <= 0) throw new Error("Invalid acoustic frame timing");
    if (!Array.isArray(observation.logProbs) || observation.logProbs.some(probabilities => !Array.isArray(probabilities) || probabilities.length !== this.#labels.length || probabilities.some(value => !Number.isFinite(value) || value > 0.001))) throw new Error("Invalid CTC log probabilities");
    if (observation.endMs < this.#latestEndMs) return this.progress(this.#latestEndMs);
    this.#latestEndMs = observation.endMs;
    // Replace overlapping, uncommitted emissions with the better-context estimate.
    // A committed word's acoustic interval is retired permanently, so revisions
    // cannot count the same sung word as another occurrence.
    const rewind = Math.max(observation.startMs + observation.frameOffsetMs, this.#retiredMs);
    if (rewind <= this.#lastFrameMs) {
      const index = this.#history.findLastIndex(frame => frame.atMs < rewind && frame.atMs >= this.#retiredMs);
      this.#scores.fill(-Infinity);
      if (index >= 0) {
        const checkpoint = this.#history[index]!;
        this.#scores.set(checkpoint.scores, checkpoint.scoreStart);
        this.#history.length = index + 1;
        this.#lastFrameMs = checkpoint.atMs;
        let maximum = -Infinity;
        for (let i = 0; i < this.#scores.length; i++) {
          if (i < this.#floor) this.#scores[i] = -Infinity;
          else maximum = Math.max(maximum, this.#scores[i]!);
        }
        if (Number.isFinite(maximum)) {
          for (let i = this.#floor; i < this.#scores.length; i++) this.#scores[i]! -= maximum;
        } else this.#scores[this.#floor] = 0;
      } else {
        this.#scores[this.#floor] = 0;
        this.#history.length = 0;
        this.#lastFrameMs = this.#retiredMs;
      }
    }
    const next = this.stages[this.#stage + 1];
    // Only the current slide and its planned successor; later slides are excluded.
    const endWord = next ? next.endWord : this.stages[this.#stage]!.endWord;
    const limit = 2 * (this.#words[endWord - 1]!.end + 1);
    for (const [frame, probabilities] of observation.logProbs.entries()) {
      const atMs = observation.startMs + observation.frameOffsetMs + frame * observation.frameStepMs;
      // A 200ms fixed lag avoids the unstable trailing edge.
      if (atMs <= this.#lastFrameMs || atMs > observation.endMs - 200) continue;
      this.#lastFrameMs = atMs;
      const updated = new Float64Array(this.#scores.length).fill(-Infinity);
      const back = new Uint16Array(limit + 1);
      const closed = this.#scores.slice();
      const origin = Uint32Array.from({ length: limit + 1 }, (_, state) => state);
      // Missing words are epsilon transitions: they consume no audio frames.
      for (const [destination, source] of this.#skip) {
        if (destination > limit || source < this.#floor) continue;
        if (closed[source]! - this.#missingWordPenalty > closed[destination]!) {
          closed[destination] = closed[source]! - this.#missingWordPenalty;
          origin[destination] = origin[source]!;
        }
      }
      let maximum = -Infinity;
      for (let state = this.#floor; state <= limit; state++) {
        let previous = closed[state]!, source = state;
        if (state > this.#floor && closed[state - 1]! > previous) { previous = closed[state - 1]!; source = state - 1; }
        if (state > this.#floor + 1 && state % 2 && this.#tokens[(state - 1) / 2] !== this.#tokens[(state - 3) / 2] && closed[state - 2]! > previous) { previous = closed[state - 2]!; source = state - 2; }
        updated[state] = previous + probabilities[state % 2 ? this.#tokens[(state - 1) / 2]! : this.#blank]!;
        back[state] = state - origin[source]!;
        maximum = Math.max(maximum, updated[state]!);
      }
      for (let state = this.#floor; state <= limit; state++) updated[state]! -= maximum;
      this.#scores = updated;
      this.#history.push({ back, probabilities, atMs, scores: updated.slice(this.#floor, limit + 1), scoreStart: this.#floor });
    }
    // Bounded backtrace: committed words retain their evidence separately.
    while (this.#history.length && this.#history[0]!.atMs < this.#lastFrameMs - 30_000) this.#history.shift();
    const bestState = this.#scores.indexOf(0);
    const peaks = new Map<number, { probability: number; atMs: number }>();
    const spans = new Map<number, { startMs: number; endMs: number }>();
    let state = bestState;
    for (let frame = this.#history.length - 1; frame >= 0 && state >= this.#floor; frame--) {
      const history = this.#history[frame]!;
      if (state % 2) {
        const token = (state - 1) / 2, probability = Math.exp(history.probabilities[this.#tokens[token]!]!);
        const span = spans.get(token);
        spans.set(token, { startMs: history.atMs, endMs: span?.endMs ?? history.atMs });
        if (probability > (peaks.get(token)?.probability ?? 0)) peaks.set(token, { probability, atMs: history.atMs });
      }
      state -= history.back[state] ?? 0;
    }
    const completedToken = Math.floor((bestState - 1) / 2);
    let lastHeard = this.#lockedWord;
    const evidence = new Map<number, PlannedWordEvidence>();
    for (let index = this.#lockedWord + 1; index < endWord; index++) {
      const word = this.#words[index]!;
      if (word.end > completedToken) break;
      const characters = Array.from({ length: word.end - word.start }, (_, i) => peaks.get(word.start + i));
      const confidence = Math.exp(characters.reduce((sum, value) => sum + Math.log(value?.probability ?? 0.000001), 0) / characters.length);
      const heard = confidence >= 0.30;
      const times = characters.flatMap(value => value ? [value.atMs] : []);
      evidence.set(index, { text: word.text, status: heard ? "heard" : "uncertain", confidence, startMs: times.length ? Math.min(...times) : null, endMs: times.length ? Math.max(...times) : null });
      if (heard) lastHeard = index;
    }
    const prospective = [...this.#proof, ...evidence].filter(([index, proof]) => next && index >= next.startWord && index < next.endWord && proof.status === "heard");
    const advance = !!next && prospective.length >= 2 && prospective.some(([, proof]) => !functionWords.has(proof.text.toLowerCase()) && proof.text.length >= 3);
    // A single word in the successor must not lock us past its other anchors.
    if (next && !advance && lastHeard >= next.startWord) {
      lastHeard = this.#lockedWord;
      for (const [index, proof] of evidence) if (index < next.startWord && proof.status === "heard") lastHeard = index;
    }
    if (lastHeard > this.#lockedWord) {
      for (const [index, proof] of evidence) if (index <= lastHeard) this.#proof.set(index, proof);
      this.#lockedWord = lastHeard;
      const word = this.#words[lastHeard]!;
      this.#retiredMs = Math.max(this.#retiredMs, spans.get(word.end - 1)?.endMs ?? -1, spans.get(word.end)?.startMs ?? -1);
      this.#floor = 2 * this.#words[lastHeard]!.end + 1;
      let maximum = -Infinity;
      for (let i = 0; i < this.#scores.length; i++) {
        if (i < this.#floor) this.#scores[i] = -Infinity;
        else maximum = Math.max(maximum, this.#scores[i]!);
      }
      for (let i = this.#floor; i < this.#scores.length; i++) this.#scores[i]! -= maximum;
    }
    if (advance) this.#stage++;
    return this.progress(observation.endMs);
  }

  progress(acousticEndMs: number): PlannedProgress {
    const stage = this.stages[this.#stage]!;
    const words = this.#words.slice(stage.startWord, stage.endWord).map((word, offset): PlannedWordEvidence => this.#proof.get(stage.startWord + offset) ?? { text: word.text, status: "pending", confidence: null, startMs: null, endMs: null });
    const next = this.#words[Math.max(stage.startWord, this.#lockedWord + 1)];
    return { stageIndex: this.#stage, words, heardWords: words.filter(word => word.status === "heard").length, totalWords: words.length, nextWord: next?.text ?? null, acousticEndMs };
  }
}
