import { words } from "./normalize.ts";
import type { Song } from "../song/model.ts";
import { samePosition, type LyricPosition, type StructureTracker } from "../song/structure.ts";

export interface TextEvidence {
  audio: number; matchedWords: number; precision: number; continuity: number; phrase: string;
  exactContentWords: string[];
}
export interface Candidate extends TextEvidence {
  slideId: string;
  text: string;
  position: LyricPosition;
  structure: number;
  proximity: number;
  history: number;
  score: number;
  expected: boolean;
  current: boolean;
}

// ASR often substitutes these short connectors. Their mismatch should weigh less
// than a missing content word; negation retains full weight.
const connectors = new Set("a an and as at by for from in of on or the to with".split(" "));
const functionWords = new Set([...connectors, ..."am are be been but do does had has have he her his i is it its me my our she so that their them they this was we were will you your".split(" ")]);
const connectorWeight = (word: string) => connectors.has(word) ? 0.2 : 1;

function wordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 3) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let beforePrevious = previous;
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) current[j] = Math.min(current[j]!, beforePrevious[j - 2]! + 1);
    }
    beforePrevious = previous;
    previous = current;
  }
  const similarity = 1 - previous[b.length]! / Math.max(a.length, b.length);
  return similarity >= 0.67 ? similarity : 0;
}

interface Alignment { weight: number; count: number; coverage: number; first: number; last: number; exactContentWords: string[] }
function alignment(observed: string[], lyric: string[], weight: (word: string) => number): Alignment {
  const empty = (): Alignment => ({ weight: 0, count: 0, coverage: 0, first: -1, last: -1, exactContentWords: [] });
  const grid = Array.from({ length: observed.length + 1 }, () => Array.from({ length: lyric.length + 1 }, empty));
  for (let i = 1; i <= observed.length; i++) {
    const word = observed[i - 1]!;
    for (let j = 1; j <= lyric.length; j++) {
      const extend = (base: Alignment, similarity: number, weighted: number, count: number, first: number): Alignment => {
        const matched = lyric.slice(first, j);
        const added = similarity === 1 ? matched.filter(word => !functionWords.has(word) && !base.exactContentWords.includes(word)) : [];
        return {
          weight: base.weight + similarity * weighted, count: base.count + count,
          coverage: base.coverage + matched.reduce((sum, word) => sum + connectorWeight(word), 0),
          first: base.first < 0 ? first : base.first, last: j - 1,
          exactContentWords: added.length ? [...new Set([...base.exactContentWords, ...added])] : base.exactContentWords,
        };
      };
      const options = [grid[i - 1]![j]!, grid[i]![j - 1]!];
      const similarity = wordSimilarity(word, lyric[j - 1]!);
      if (similarity) options.push(extend(grid[i - 1]![j - 1]!, similarity, weight(word), 1, j - 1));
      if (i > 1) {
        const joined = wordSimilarity(observed[i - 2]! + word, lyric[j - 1]!);
        if (joined >= 0.8) options.push(extend(grid[i - 2]![j - 1]!, joined, weight(observed[i - 2]!) + weight(word), 2, j - 1));
      }
      if (j > 1) {
        const joined = wordSimilarity(word, lyric[j - 2]! + lyric[j - 1]!);
        if (joined >= 0.8) options.push(extend(grid[i - 1]![j - 2]!, joined, weight(word), 1, j - 2));
      }
      grid[i]![j] = options.reduce((best, item) => item.weight > best.weight ? item : best);
    }
  }
  return grid[observed.length]![lyric.length]!;
}

export class LyricMatcher {
  readonly #song: Song;
  readonly #idf = new Map<string, number>();
  constructor(song: Song) {
    this.#song = song;
    for (const slide of song.slides) for (const word of new Set(slide.words)) this.#idf.set(word, (this.#idf.get(word) ?? 0) + 1);
    for (const [word, count] of this.#idf) this.#idf.set(word, 1 + Math.log((song.slides.length + 1) / (count + 1)));
  }

  #evidence(transcript: string[], lyric: string[]): TextEvidence {
    let best: TextEvidence = { audio: 0, matchedWords: 0, precision: 0, continuity: 0, phrase: "", exactContentWords: [] };
    if (!transcript.length || !lyric.length) return best;
    const recent = transcript.slice(-18);
    const minimum = Math.min(3, recent.length);
    for (let length = minimum; length <= recent.length; length++) {
      const phrase = recent.slice(-length);
      // Connector importance is grammatical, not dependent on how few slides
      // happen to contain it. Content words retain song-specific rarity weights.
      const weight = (word: string) => connectors.has(word) ? 0.2 : this.#idf.get(word) ?? 2.5;
      const match = alignment(phrase, lyric, weight);
      const precision = match.weight / phrase.reduce((sum, word) => sum + weight(word), 0);
      // Missing connectors create smaller gaps than missing content words.
      const span = lyric.slice(match.first, match.last + 1).reduce((sum, word) => sum + connectorWeight(word), 0);
      const continuity = span ? Math.min(1, match.coverage / span) : 0;
      const strength = Math.min(1, match.count / 3);
      const audio = Math.min(1, precision * (0.85 + 0.15 * continuity) * strength);
      if (audio > best.audio || (audio === best.audio && match.count > best.matchedWords)) {
        best = { audio, matchedWords: match.count, precision, continuity, phrase: phrase.join(" "), exactContentWords: match.exactContentWords };
      }
    }
    return best;
  }

  rank(text: string, tracker: StructureTracker): Candidate[] {
    const transcript = words(text);
    const current = tracker.current;
    const expected = tracker.expected;
    const currentSlide = this.#song.slides.find(slide => slide.id === current.slideId)!;
    return this.#song.slides.map(slide => {
      const position = tracker.resolve(slide);
      const isExpected = expected !== null && samePosition(position, expected);
      const isCurrent = samePosition(position, current);
      const structure = isExpected ? 1 : isCurrent ? 0.8 : slide.sectionId === current.sectionId ? 0.55 : 0.12;
      const proximity = isExpected || isCurrent ? 1 : 1 / (1 + Math.abs(slide.index - currentSlide.index));
      const history = isExpected || isCurrent ? 1 : tracker.history.slice(-2).includes(slide.id) ? 0.1 : 0.5;
      const evidence = this.#evidence(transcript, slide.words);
      return {
        ...evidence, slideId: slide.id, text: slide.text, position, structure, proximity, history,
        // An inspectable score, not a calibrated probability. Text dominates;
        // off-plan transitions have their own stronger evidence/stability gate.
        score: evidence.audio * (0.78 + 0.14 * structure + 0.06 * proximity + 0.02 * history),
        expected: isExpected, current: isCurrent,
      };
    }).sort((a, b) => b.score - a.score || b.matchedWords - a.matchedWords || a.slideId.localeCompare(b.slideId));
  }
}
