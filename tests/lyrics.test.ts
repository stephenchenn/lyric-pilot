import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeLyrics } from "../src/lyrics/normalize.ts";
import { LyricMatcher } from "../src/lyrics/matcher.ts";
import { loadSong, parseArrangement, parseSong } from "../src/song/model.ts";
import { StructureTracker } from "../src/song/structure.ts";

test("normalization handles Unicode, annotations and contractions without destroying ordinary words", () => {
  assert.equal(normalizeLyrics("[Chorus]\n YOU’VE been faithful! Café — thru the storm."), "you have been faithful cafe through the storm");
  assert.equal(normalizeLyrics("We're well; were we ill? It's hope."), "we are well were we ill it is hope");
  assert.equal(normalizeLyrics("youve been faithful\n\n"), "you have been faithful");
});

test("song ingestion validates identities, ownership and planned occurrences", () => {
  const song = loadSong();
  assert.equal(song.arrangement[3]?.occurrence, 2);
  assert.equal(song.arrangement[5]?.occurrence, 3);
  assert.deepEqual(parseArrangement("Verse 1 → Chorus -> V2, C | Bridge", song.sections).map(step => step.sectionId), ["V1", "C", "V2", "C", "B"]);
  assert.throws(() => parseArrangement("V1 -> Unknown", song.sections), /Unknown/);
  const raw = JSON.parse(readFileSync(new URL("../data/songs/synthetic-test/song.json", import.meta.url), "utf8"));
  const duplicate = structuredClone(raw); duplicate.slides[1].id = duplicate.slides[0].id;
  assert.throws(() => parseSong(duplicate), /unique|unknown/i);
  const missing = structuredClone(raw); missing.sections[0].slideIds.push("missing");
  assert.throws(() => parseSong(missing), /unknown/i);
});

test("fuzzy matching tolerates typos and split words, and remains deterministic", () => {
  const song = loadSong();
  const tracker = new StructureTracker(song, "s3");
  const matcher = new LyricMatcher(song);
  const rank = matcher.rank("you will lead us safley home", tracker);
  assert.equal(rank[0]?.slideId, "s4");
  assert.ok(rank[0]!.audio > 0.85);
  assert.deepEqual(rank, matcher.rank("you will lead us safley home", tracker));
  const custom = parseSong({
    id: "split", title: "Split words", presentationId: "split", arrangement: ["V"],
    sections: [{ id: "V", label: "Verse", slideIds: ["a", "b"] }],
    slides: [{ id: "a", index: 0, text: "All my life you have been faithful" }, { id: "b", index: 1, text: "Morning breaks across the valley" }],
  });
  const split = new LyricMatcher(custom).rank("all my life youve been faith full", new StructureTracker(custom));
  assert.equal(split[0]?.slideId, "a");
  assert.ok(split[0]!.audio > 0.85);
});

test("strong off-plan text defeats a planned next slide and exposes component scores", () => {
  const song = loadSong();
  const candidates = new LyricMatcher(song).rank("we will follow we will follow", new StructureTracker(song, "s6", 2));
  assert.equal(candidates[0]?.slideId, "s7");
  assert.equal(candidates[0]?.expected, false);
  assert.equal(candidates[0]?.audio, 1);
  assert.ok(candidates[0]!.structure < candidates.find(candidate => candidate.slideId === "s3")!.structure);
  for (const key of ["audio", "structure", "proximity", "history", "score"] as const) assert.ok(Number.isFinite(candidates[0]![key]));
});

test("connector errors weigh less than missing content, and exact content words are distinct and ordered", () => {
  const song = loadSong(new URL("./fixtures/noisy-phrase-song.json", import.meta.url).pathname);
  const matcher = new LyricMatcher(song), tracker = new StructureTracker(song);
  const target = (text: string) => matcher.rank(text, tracker).find(candidate => candidate.slideId === "b")!;
  const recognized = target("you quiet lantern and orchard");
  assert.ok(recognized.audio >= 0.90);
  assert.deepEqual(recognized.exactContentWords, ["quiet", "lantern", "orchard"]);
  assert.ok(target("you quiet lantern and open").audio < recognized.audio);
  assert.ok(target("orchard lantern quiet").audio < recognized.audio);
  assert.deepEqual(target("lantern lantern lantern").exactContentWords, ["lantern"]);
  assert.ok(target("quirt lantern and orchard").exactContentWords.length < 3, "Fuzzy matches do not become exact content evidence");
});

test("arrangement priors distinguish physical copies with identical chorus text", () => {
  const song = parseSong({
    id: "duplicate", title: "Duplicate choruses", presentationId: "duplicate", arrangement: ["C1", "V", "C2"],
    sections: [{ id: "C1", label: "Chorus", slideIds: ["c1"] }, { id: "V", label: "Verse", slideIds: ["v"] }, { id: "C2", label: "Chorus", slideIds: ["c2"] }],
    slides: [{ id: "c1", index: 0, text: "Light will guide us home" }, { id: "v", index: 1, text: "We walk along the river" }, { id: "c2", index: 2, text: "Light will guide us home" }],
  });
  const candidates = new LyricMatcher(song).rank("light will guide us home", new StructureTracker(song, "v", 1));
  assert.equal(candidates[0]?.slideId, "c2");
  assert.equal(candidates[0]?.audio, candidates.find(candidate => candidate.slideId === "c1")?.audio);
});

test("shared physical chorus slides advance logical occurrences; extra repeats preserve the next bridge", () => {
  const tracker = new StructureTracker(loadSong(), "s6", 2);
  const song = tracker.song;
  const accept = (id: string) => tracker.accept(tracker.resolve(song.slides.find(slide => slide.id === id)!));
  accept("s3"); assert.equal(tracker.current.occurrence, 2);
  accept("s4"); accept("s3");
  assert.equal(tracker.current.extraRepeat, 1);
  assert.equal(tracker.current.stepIndex, 3);
  accept("s4"); assert.equal(tracker.expected?.slideId, "s7");
  accept("s7"); accept("s8"); accept("s3");
  assert.equal(tracker.current.occurrence, 3);
  assert.equal(tracker.current.extraRepeat, 0);
});
