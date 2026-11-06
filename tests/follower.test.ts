import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSong, parseSong } from "../src/song/model.ts";
import { LyricFollower } from "../src/follower/engine.ts";
import { TranscriptBuffer } from "../src/transcription/buffer.ts";
import { replay, parseScenario } from "../src/replay/replay.ts";
import { renderTimeline } from "../src/replay/timeline.ts";
import { syntheticScenarios } from "../src/replay/scenarios.ts";
import type { TranscriptEvent } from "../src/transcription/types.ts";
import { MemoryLogger } from "./helpers.ts";

const transcript = (text: string, atMs: number, options: Partial<TranscriptEvent> = {}): TranscriptEvent => ({
  type: "transcript", id: `event-${atMs}`, startMs: atMs, endMs: atMs, atMs, text, final: false, ...options,
});

test("interim updates replace text, final corrections persist, stale and duplicate events do not accumulate", () => {
  const buffer = new TranscriptBuffer(3500);
  assert.equal(buffer.add(transcript("wrong interim", 100, { id: "u", final: false })), true);
  assert.equal(buffer.add(transcript("correct words", 200, { id: "u", final: true })), true);
  assert.equal(buffer.add(transcript("old wrong words", 300, { id: "u", final: false })), false);
  assert.equal(buffer.text(300), "correct words");
  assert.equal(buffer.add(transcript("correct words", 300, { id: "u", startMs: 200, endMs: 200, final: true })), false);
  assert.equal(buffer.text(4000), "");
  assert.throws(() => buffer.add(transcript("future", 100, { endMs: 101 })), /before their audio ends/);
});

test("ASSIST tracks suggestions, MANUAL holds, AUTO controls simulated output", () => {
  for (const mode of ["ASSIST", "MANUAL", "AUTO"] as const) {
    const engine = new LyricFollower(loadSong(), new MemoryLogger(), { mode });
    const frame = engine.observe(transcript("we lift our voices together", 1000, { final: true }));
    assert.equal(frame.displayedSlideId, mode === "AUTO" ? "s2" : "s1");
    assert.equal(frame.tracked.slideId, mode === "MANUAL" ? "s1" : "s2");
  }
});

test("a distinctive expected partial anticipates; short ambiguous fragments cannot trigger", () => {
  const engine = new LyricFollower(loadSong(), new MemoryLogger(), { mode: "AUTO" });
  let frame = engine.observe(transcript("we will", 500));
  assert.equal(frame.decision.action, "hold");
  frame = engine.observe(transcript("we lift our voices", 1000));
  assert.equal(frame.displayedSlideId, "s2");
  assert.equal(frame.decision.action, "trigger");
});

test("three distinctive words identify the expected slide despite a misheard connective and a weak prior window", () => {
  const song = loadSong(new URL("./fixtures/noisy-phrase-song.json", import.meta.url).pathname);
  const engine = new LyricFollower(song, new MemoryLogger(), { mode: "AUTO", windowMs: 5000 });
  const observe = (text: string, atMs: number) => engine.observe(transcript(text, atMs, { id: "rolling-audio", startMs: atMs - 5000, endMs: atMs - 700 }));
  assert.equal(observe("You hit it", 23244).displayedSlideId, "a");
  assert.equal(observe("You quiet lantern", 24668).displayedSlideId, "a");
  assert.equal(observe("You hit and lantern and open", 26191).displayedSlideId, "a");
  const recognized = observe("You quiet lantern and orchard", 27686);
  assert.equal(recognized.displayedSlideId, "b");
  assert.equal(recognized.decision.accepted, true);
  assert.equal(recognized.decision.reason, "distinctive planned phrase");
  assert.deepEqual(recognized.candidates[0]?.exactContentWords, ["quiet", "lantern", "orchard"]);
  assert.equal(engine.transitions.length, 1);
});

test("the planned phrase shortcut rejects short, repeated, generic and ambiguous evidence", () => {
  const song = loadSong(new URL("./fixtures/noisy-phrase-song.json", import.meta.url).pathname);
  for (const phrase of ["quiet lantern", "lantern lantern lantern", "in the orchard", "quiet lantern and open", "quirt lantern and orchard", "quiet lantern not orchard", "quiet lantern after orchard"]) {
    const engine = new LyricFollower(song, new MemoryLogger(), { mode: "AUTO" });
    assert.equal(engine.observe(transcript(phrase, 1000)).displayedSlideId, "a", phrase);
  }
  const ambiguous = structuredClone(song);
  ambiguous.slides[0]!.text = ambiguous.slides[1]!.text;
  ambiguous.slides[0]!.words = [...ambiguous.slides[1]!.words];
  const engine = new LyricFollower(ambiguous, new MemoryLogger(), { mode: "AUTO" });
  assert.equal(engine.observe(transcript("quiet lantern and orchard", 1000)).displayedSlideId, "a");
});

test("three exact content words do not bypass temporal support for an off-plan jump", () => {
  const song = loadSong(new URL("./fixtures/noisy-phrase-song.json", import.meta.url).pathname);
  song.sections[0]!.slideIds = ["a", "c", "b"];
  song.slides.forEach(slide => { slide.sectionSlideIndex = song.sections[0]!.slideIds.indexOf(slide.id); });
  const engine = new LyricFollower(song, new MemoryLogger(), { mode: "AUTO" });
  const frame = engine.observe(transcript("quiet lantern orchard", 1000));
  assert.deepEqual(frame.candidates[0]?.exactContentWords, ["quiet", "lantern", "orchard"]);
  assert.equal(frame.candidates[0]?.expected, false);
  assert.equal(frame.displayedSlideId, "a");
  assert.equal(frame.decision.accepted, false);
});

test("off-plan jumps require sustained fresh observations, never ticks or duplicate submissions", () => {
  const engine = new LyricFollower(loadSong(), new MemoryLogger(), { mode: "AUTO", initialSlideId: "s6", initialStepIndex: 2 });
  const first = transcript("we will follow we will follow", 1000);
  assert.equal(engine.observe(first).decision.action, "hold");
  assert.equal(engine.observe({ type: "tick", atMs: 1700 }).decision.action, "hold");
  assert.equal(engine.observe({ ...first, atMs: 1800 }).decision.action, "hold");
  const jumped = engine.observe(transcript("we will follow we will follow", 1900));
  assert.equal(jumped.displayedSlideId, "s7");
  assert.equal(jumped.deviation, true);
  assert.equal(jumped.expected?.slideId, "s8");
});

test("human correction cancels pending evidence and suppresses conflicting automatic action", () => {
  const engine = new LyricFollower(loadSong(), new MemoryLogger(), { mode: "AUTO" });
  engine.observe(transcript("we will follow we will follow", 1000));
  const manual = engine.observe({ type: "manual", atMs: 1100, slideId: "s5", stepIndex: 2 });
  assert.equal(manual.transcript, "");
  assert.equal(manual.displayedSlideId, "s5");
  assert.equal(engine.observe(transcript("we will follow we will follow", 2000, { final: true })).decision.reason, "manual override cooldown");
  assert.equal(engine.observe({ type: "tick", atMs: 3300 }).displayedSlideId, "s5");
  const recovered = engine.observe(transcript("still we choose to walk in hope", 4500, { final: true }));
  assert.equal(recovered.displayedSlideId, "s6");
});

test("pause, input loss and mode changes require fresh evidence before output resumes", () => {
  const engine = new LyricFollower(loadSong(), new MemoryLogger(), { mode: "AUTO" });
  engine.observe({ type: "pause", atMs: 0, paused: true });
  assert.equal(engine.observe(transcript("we lift our voices together", 1000, { final: true })).displayedSlideId, "s1");
  assert.equal(engine.observe({ type: "pause", atMs: 1100, paused: false }).transcript, "");
  engine.observe({ type: "health", atMs: 1200, healthy: false, message: "provider failed" });
  assert.equal(engine.observe(transcript("we lift our voices together", 2000, { final: true })).displayedSlideId, "s1");
  engine.observe({ type: "health", atMs: 2100, healthy: true, message: "restored" });
  assert.equal(engine.observe({ type: "tick", atMs: 2200 }).displayedSlideId, "s1");
  assert.equal(engine.observe(transcript("we lift our voices together", 2300, { final: true })).displayedSlideId, "s2");
  engine.observe({ type: "mode", atMs: 2400, mode: "ASSIST" });
  engine.observe(transcript("you are with us through the storm", 3500, { final: true }));
  const auto = engine.observe({ type: "mode", atMs: 3600, mode: "AUTO" });
  assert.equal(auto.displayedSlideId, "s2");
  assert.equal(auto.transcript, "");
});

test("silence holds state; no low-evidence wander or repeated trigger of the current slide", () => {
  const engine = new LyricFollower(loadSong(), new MemoryLogger(), { mode: "AUTO" });
  engine.observe(transcript("we lift our voices together", 1000, { final: true }));
  const frame = engine.observe({ type: "tick", atMs: 10000 });
  assert.equal(frame.displayedSlideId, "s2");
  assert.equal(frame.transcript, "");
  engine.observe(transcript("please adjust the monitor volume", 11000, { final: true }));
  engine.observe(transcript("we lift our voices together", 12000, { final: true }));
  assert.equal(engine.transitions.length, 1);
});

test("a uniquely identifying three-word off-plan phrase still needs temporal support", () => {
  const song = loadSong(new URL("../data/songs/amazing-grace-first-verse/song.json", import.meta.url).pathname);
  const engine = new LyricFollower(song, new MemoryLogger(), { mode: "AUTO" });
  assert.equal(engine.observe(transcript("once was lost", 1000)).decision.action, "hold");
  const frame = engine.observe(transcript("once was lost", 1800));
  assert.equal(frame.displayedSlideId, "ag3");
  assert.equal(frame.deviation, true);
});

test("identical current/next lyrics abstain instead of inventing an audible boundary", () => {
  const song = parseSong({
    id: "ambiguous", title: "Ambiguous", presentationId: "ambiguous", arrangement: ["A", "B"],
    sections: [{ id: "A", label: "A", slideIds: ["a"] }, { id: "B", label: "B", slideIds: ["b"] }],
    slides: [{ id: "a", index: 0, text: "you are good and faithful" }, { id: "b", index: 1, text: "you are good and faithful" }],
  });
  const engine = new LyricFollower(song, new MemoryLogger(), { mode: "AUTO" });
  const frame = engine.observe(transcript("you are good and faithful", 1000, { final: true }));
  assert.equal(frame.decision.reason, "ambiguous candidates");
  assert.equal(frame.displayedSlideId, "a");
});

test("one-slide repeated sections do not re-trigger or advance logical occurrences from sustained lyrics", () => {
  const song = parseSong({
    id: "single", title: "Single slide", presentationId: "single", arrangement: ["C", "C", "C"],
    sections: [{ id: "C", label: "Chorus", slideIds: ["c"] }],
    slides: [{ id: "c", index: 0, text: "we will follow all our days" }],
  });
  const engine = new LyricFollower(song, new MemoryLogger(), { mode: "AUTO" });
  for (const atMs of [1000, 2000, 3000]) {
    const frame = engine.observe(transcript("we will follow all our days", atMs, { final: true }));
    assert.equal(frame.tracked.occurrence, 1);
    assert.equal(frame.displayedSlideId, "c");
  }
  assert.equal(engine.transitions.length, 0);
  engine.observe({ type: "manual", atMs: 4000, slideId: "c", stepIndex: 1 });
  assert.equal(engine.tracker.current.occurrence, 2);
});

test("all synthetic arrangement scenarios complete their annotated transitions without false triggers", async () => {
  const song = loadSong();
  for (const scenario of syntheticScenarios(song)) {
    const report = await replay(song, scenario, new MemoryLogger());
    assert.equal(report.metrics?.missedTransitions, 0, scenario.name);
    assert.equal(report.metrics?.falseTransitions, 0, scenario.name);
    if (scenario.name !== "manual-correction") assert.equal(report.metrics?.top1Accuracy, 1, scenario.name);
    assert.ok(report.metrics!.trackingTimeAccuracy < 1, "Recognition delay must reduce time accuracy rather than being hidden");
    if (scenario.name === "extra-chorus") {
      assert.ok(report.transitions.some(transition => transition.position.extraRepeat === 1));
      assert.equal(report.transitions.at(-2)?.position.occurrence, 3);
    }
  }
});

test("replay validates event ordering, independent ground truth and clock correctness", async () => {
  const song = loadSong();
  const scenario = syntheticScenarios(song)[0]!;
  const invalid = structuredClone(scenario); invalid.events.reverse();
  assert.throws(() => parseScenario(invalid, song), /ordered/);
  const unknown = structuredClone(scenario); unknown.groundTruth[0]!.slideId = "missing";
  assert.throws(() => parseScenario(unknown, song), /Ground truth/);
  const engine = new LyricFollower(song, new MemoryLogger());
  engine.observe({ type: "tick", atMs: 100 });
  assert.throws(() => engine.observe({ type: "tick", atMs: 99 }), /nondecreasing/);
  const assist = await replay(song, scenario, new MemoryLogger(), { mode: "ASSIST" });
  assert.ok(assist.metrics!.trackingTimeAccuracy > assist.metrics!.displayedTimeAccuracy);
  assert.ok(assist.frames.every(frame => frame.displayedSlideId === "s1"));
  const graphic = renderTimeline({ ...assist, name: '<script>"untrusted"</script>' });
  assert.ok(graphic.includes("&lt;script&gt;"));
  assert.ok(!graphic.includes("<script>"));
});

test("captured local speech transcripts retain window settings and reproduce all bridge-jump transitions", async () => {
  const song = loadSong();
  const { loadScenario } = await import("../src/replay/replay.ts");
  const scenario = loadScenario(new URL("./fixtures/captured-spoken-bridge.json", import.meta.url).pathname, song);
  const report = await replay(song, scenario, new MemoryLogger());
  assert.equal(scenario.transcriptWindowMs, 5000);
  assert.deepEqual(report.transitions.map(transition => transition.slideId), ["s2", "s7", "s8", "s3", "s4"]);
  assert.equal(report.metrics?.missedTransitions, 0);
  assert.equal(report.metrics?.falseTransitions, 0);
  assert.ok(report.metrics!.medianLatencyMs! > 2000, "Measured decode delay must remain visible");
});

test("predictions arriving after recording end do not receive transition or correct-time credit", async () => {
  const song = loadSong();
  const scenario = parseScenario({
    name: "late-decode", durationMs: 6000, evaluationDurationMs: 3000,
    events: [transcript("we lift our voices together", 4000, { startMs: 2000, endMs: 2500, final: true })],
    groundTruth: [{ atMs: 0, slideId: "s1" }, { atMs: 2000, slideId: "s2" }],
  }, song);
  const report = await replay(song, scenario, new MemoryLogger());
  assert.equal(report.transitions[0]?.slideId, "s2");
  assert.equal(report.metrics?.matchedTransitions, 0);
  assert.equal(report.metrics?.missedTransitions, 1);
  assert.equal(report.metrics?.falseTransitions, 1);
  assert.equal(report.metrics?.displayedTimeAccuracy, 2 / 3);
});
