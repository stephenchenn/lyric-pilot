import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseSong } from "../src/song/model.ts";
import { PlannedWordTracker, type AcousticObservation } from "../src/lyrics/planned.ts";
import { PlannedFollower } from "../src/follower/planned.ts";
import { runPlannedAudio } from "../src/audio/planned.ts";
import { encodeWav } from "../src/audio/pcm.ts";
import { formatFrame, formatMetrics } from "../src/follower/display.ts";
import { parsePlannedReplay, replayPlanned } from "../src/replay/planned.ts";
import { MemoryLogger } from "./helpers.ts";

const labels = ["<pad>", "|", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "'"];
const song = (first = "MORNING LIGHT") => parseSong({
  id: "planned", title: "Original planned test", presentationId: "planned", arrangement: ["V"],
  sections: [{ id: "V", label: "Verse", slideIds: ["a", "b", "c"] }],
  slides: [{ id: "a", index: 0, text: first }, { id: "b", index: 1, text: "RIVER FLOWS" }, { id: "c", index: 2, text: "GARDEN GROWS" }],
});
function observation(text: string, startMs = 0): AcousticObservation {
  const ids: number[] = [];
  for (const character of text.trim().replaceAll(" ", "|") + (text ? "|" : "")) ids.push(labels.indexOf(character), 0);
  ids.push(...Array<number>(12).fill(0));
  return { startMs, endMs: startMs + ids.length * 20, frameOffsetMs: 0, frameStepMs: 20, text: "DIAGNOSTIC TEXT IS NOT THE ALIGNMENT INPUT", decodeMs: 10,
    logProbs: ids.map(hot => labels.map((_, id) => Math.log(id === hot ? 0.99 : 0.01 / (labels.length - 1)))) };
}

test("planned tracking uses acoustic emissions and only permits the next arranged slide", () => {
  const tracker = new PlannedWordTracker(song(), labels);
  let frame = tracker.update(observation("GARDEN GROWS"));
  assert.equal(frame.stageIndex, 0, "A later slide cannot be selected");
  const next = observation("RIVER FLOWS", 1000);
  frame = tracker.update(next);
  assert.equal(frame.stageIndex, 1);
  assert.deepEqual(frame.words.map(word => word.status), ["heard", "heard"]);
  assert.equal(tracker.update(next).stageIndex, 1, "An overlapping replay must not advance twice");
});

test("silence, wrong speech, or expected text without acoustic support do not advance", () => {
  const tracker = new PlannedWordTracker(song(), labels);
  const silence = observation(""); silence.text = "RIVER FLOWS";
  assert.equal(tracker.update(silence).heardWords, 0);
  assert.equal(tracker.update(observation("ZZZZZZ", 1000)).stageIndex, 0);
  assert.equal(tracker.update(observation("", 5000)).stageIndex, 0);
});

test("overlapping audio cannot satisfy a second occurrence of a repeated word", () => {
  const tracker = new PlannedWordTracker(song("LIGHT LIGHT"), labels);
  const first = observation("LIGHT");
  assert.equal(tracker.update(first).heardWords, 1);
  assert.equal(tracker.update(first).heardWords, 1);
  const repeated = observation("LIGHT", first.endMs);
  assert.equal(tracker.update(repeated).heardWords, 2);
  assert.equal(tracker.stageIndex, 0, "Finishing words alone does not invent successor audio");
});

test("a later acoustic estimate can revise an uncommitted word without inventing another occurrence", () => {
  const tracker = new PlannedWordTracker(song(), labels);
  const complete = observation("RIVER FLOWS"), early = structuredClone(complete);
  for (let frame = 0; frame < 10; frame++) early.logProbs[frame] = labels.map((_, id) => Math.log(id === 0 ? 0.99 : 0.01 / (labels.length - 1)));
  assert.equal(tracker.update(early).stageIndex, 0, "One supported successor word is insufficient");
  assert.equal(tracker.update(complete).stageIndex, 1, "Revised evidence covers the same audio interval");
  assert.equal(tracker.update(complete).stageIndex, 1, "Committed audio cannot advance another occurrence");
  const stale = observation("GARDEN GROWS"); stale.endMs = complete.endMs - 20;
  assert.equal(tracker.update(stale).stageIndex, 1, "A stale estimate cannot roll back the acoustic cursor");
});

test("missing words remain uncertain rather than being labelled heard", () => {
  const tracker = new PlannedWordTracker(song("ONE LOST WORD"), labels);
  const progress = tracker.update(observation("ONE WORD"));
  assert.equal(progress.words[0]?.status, "heard");
  assert.notEqual(progress.words[1]?.status, "heard");
  assert.equal(progress.words[2]?.status, "heard");
});

test("planned AUTO, ASSIST and MANUAL preserve their output semantics", () => {
  for (const mode of ["AUTO", "ASSIST", "MANUAL"] as const) {
    const reference = song(), engine = new PlannedFollower(reference, new MemoryLogger(), { labels, blank: 0 }, mode);
    const input = observation("RIVER FLOWS");
    const frame = engine.observe(input, input.endMs + 100);
    assert.equal(frame.displayedSlideId, mode === "AUTO" ? "b" : "a");
    assert.equal(frame.tracked.slideId, mode === "MANUAL" ? "a" : "b");
    assert.match(formatFrame(frame, reference), /FOLLOWING/);
    assert.match(formatFrame(frame, reference, { diagnostics: true }), /fixed lyric plan|Fixed|Following|following/);
  }
});

test("planned observation validation and English vocabulary errors are explicit", () => {
  const engine = new PlannedFollower(song(), new MemoryLogger(), { labels, blank: 0 });
  const input = observation("RIVER FLOWS");
  assert.throws(() => engine.observe(input, input.endMs - 1), /availability/);
  const invalid = observation("RIVER FLOWS"); invalid.logProbs[0] = [NaN];
  invalid.endMs = 100_000;
  const continuing = new PlannedWordTracker(song(), labels);
  assert.throws(() => continuing.update(invalid), /probabilities/);
  assert.equal(continuing.update(input).stageIndex, 1, "Invalid data cannot poison the acoustic cursor");
  assert.throws(() => new PlannedWordTracker(song(), ["<pad>"]), /vocabulary/);
  const lowercase = new PlannedWordTracker(song(), labels.map(label => label.length === 1 ? label.toLowerCase() : label));
  assert.equal(lowercase.update(observation("RIVER FLOWS")).stageIndex, 1, "Lowercase acoustic vocabularies retain the same token identities");
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
test("planned audio evaluates annotations only after inference and closes its worker", { skip: !hasFfmpeg }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "lyric-pilot-planned-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const audio = join(directory, "input.wav"), truth = join(directory, "truth.json");
  const pcm = Buffer.alloc(32 * 1500); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(5000, i);
  writeFileSync(audio, encodeWav(pcm));
  let calls = 0, closed = false;
  const result = await runPlannedAudio(song(), new MemoryLogger(), { file: audio }, {
    mode: "AUTO", truthPath: truth, windowMs: 1000, stepMs: 500,
    transcriber: {
      async ready() { return { labels, blank: 0 }; },
      async transcribe(window) {
        calls++;
        if (calls === 3) {
          // The file does not exist until inference is finishing.
          writeFileSync(truth, JSON.stringify([{ atMs: 0, slideId: "a" }, { atMs: 1000, slideId: "b" }]));
        }
        if (calls === 2) return { ...observation("RIVER FLOWS", 300), startMs: window.startMs, endMs: window.endMs, frameOffsetMs: 300 };
        return { ...observation(""), startMs: window.startMs, endMs: window.endMs };
      },
      close() { closed = true; },
    },
  });
  assert.equal(closed, true);
  assert.equal(result.report.transitions[0]?.slideId, "b");
  assert.equal(result.report.metrics?.matchedTransitions, 1);
  assert.equal(result.report.metrics?.top1Accuracy, null);
  assert.match(formatMetrics(result.report.metrics), /ranking is not used/);
  const capture = { vocabulary: result.vocabulary, observations: result.observations };
  const replayTruth = join(directory, "replay-truth.json");
  const replayed = await replayPlanned(song(), capture, new MemoryLogger(), {
    truthPath: replayTruth,
    onFrame(frame) {
      if (frame.atMs === result.report.frames.at(-1)!.atMs) writeFileSync(replayTruth, JSON.stringify([{ atMs: 0, slideId: "a" }, { atMs: 1000, slideId: "b" }]));
    },
  });
  assert.deepEqual(replayed.transitions, result.report.transitions, "Replay retains measured availability times without a model");
  assert.deepEqual(replayed.metrics, result.report.metrics);
  const unordered = structuredClone(capture); unordered.observations.reverse();
  assert.throws(() => parsePlannedReplay(unordered), /ordered/);
});
