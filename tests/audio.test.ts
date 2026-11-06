import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { AudioRingBuffer, encodeWav, rollingWindows, rms } from "../src/audio/pcm.ts";
import { runProcess } from "../src/audio/process.ts";
import { parseWhisperJson, WhisperCppTranscriber, type WindowTranscriber } from "../src/transcription/whisper.ts";
import { transcribeWindows } from "../src/transcription/pipeline.ts";
import { runAudio, saveAudioRun } from "../src/audio/run.ts";
import { loadSong } from "../src/song/model.ts";
import { loadScenario, replay } from "../src/replay/replay.ts";
import { MemoryLogger } from "./helpers.ts";

async function* buffers(...values: Buffer[]) { yield* values; }

test("audio ring remains bounded and preserves sample order across wraps and oversized writes", () => {
  const ring = new AudioRingBuffer(1); // 16 PCM16 samples.
  const first = Buffer.from(Array.from({ length: 40 }, (_, index) => index));
  ring.push(first.subarray(0, 20)); ring.push(first.subarray(20));
  assert.deepEqual(ring.read(), first.subarray(8));
  ring.push(Buffer.alloc(64, 123));
  assert.deepEqual(ring.read(), Buffer.alloc(32, 123));
  assert.throws(() => ring.push(Buffer.alloc(1)), /complete samples/);
});

test("rolling audio windows are causal, bounded and invariant to odd stream chunk boundaries", async () => {
  const pcm = Buffer.alloc(32 * 1250);
  for (let index = 0; index < pcm.length / 2; index++) pcm.writeInt16LE(index % 32768, index * 2);
  const windows = [];
  for await (const window of rollingWindows(buffers(pcm.subarray(0, 99), pcm.subarray(99, 30001), pcm.subarray(30001)), { windowMs: 750, stepMs: 500 })) windows.push(window);
  assert.deepEqual(windows.map(window => [window.startMs, window.endMs]), [[0, 500], [250, 1000], [500, 1250]]);
  for (const window of windows) assert.deepEqual(window.pcm, pcm.subarray(window.startMs * 32, window.endMs * 32));
  assert.equal(windows.at(-1)?.final, true);
  assert.equal(rms(Buffer.alloc(320)), 0);
  await assert.rejects(async () => { for await (const _ of rollingWindows(buffers(Buffer.alloc(3)))) { /* consume */ } }, /incomplete/);
});

test("WAV encoding declares the actual sample rate and mono PCM16 format", () => {
  const wav = encodeWav(Buffer.alloc(320));
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 320);
});

test("transcription availability includes inference backlog rather than backdating results", async () => {
  const windows = rollingWindows(buffers(Buffer.alloc(32 * 1500, 12)), { windowMs: 1000, stepMs: 500 });
  const provider: WindowTranscriber = { async transcribe() { return { text: "hello", words: [], decodeMs: 700, silence: false }; } };
  const events = [];
  for await (const event of transcribeWindows(windows, provider)) events.push(event);
  assert.deepEqual(events.map(event => event.atMs), [1200, 1900, 2600, 2600]);
  assert.deepEqual(events.map(event => event.endMs), [500, 1000, 1500, 1500]);
  assert.equal(events.at(-1)?.final, true);
});

test("Whisper JSON decoding keeps absolute word times and removes non-lyric annotations", () => {
  const window = { pcm: Buffer.alloc(320), startMs: 5000, endMs: 6000, rms: 0.1, final: false };
  const parsed = parseWhisperJson({ transcription: [
    { text: "[Music]", offsets: { from: 0, to: 100 } },
    { text: " We follow", offsets: { from: 100, to: 900 } },
  ] }, window);
  assert.equal(parsed.text, "We follow");
  assert.equal(parsed.words[0]?.startMs, 5100);
  assert.equal(parsed.words[1]?.endMs, 5900);
  assert.throws(() => parseWhisperJson({ transcription: [{ text: "oops", offsets: { from: 2, to: 1 } }] }, window), /Invalid/);
  assert.throws(() => parseWhisperJson({}, window), /missing/);
});

test("local subprocesses propagate errors and cancellation without invoking a shell", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", "literal $(not-a-command)"]);
  assert.equal(result.stdout.toString(), "literal $(not-a-command)");
  await assert.rejects(runProcess(process.execPath, ["-e", "process.exit(5)"]), /exited 5/);
  await assert.rejects(runProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { timeoutMs: 50 }), /cancelled|timed out|aborted/i);
});

test("missing local ASR dependencies give an actionable diagnostic", () => {
  assert.throws(() => new WhisperCppTranscriber({ binary: "/nonexistent/whisper", model: "/nonexistent/model" }), /setup:whisper/);
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
test("recorded WAV flows through FFmpeg, provider, follower and reproducible transcript export", { skip: !hasFfmpeg }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "lyric-pilot-pipeline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "input.wav");
  await writeFile(file, encodeWav(Buffer.alloc(32 * 2500, 20)));
  const transcriber: WindowTranscriber = { async transcribe(window) {
    const text = "we lift our voices together";
    return { text, words: text.split(" ").map(text => ({ text, startMs: window.startMs, endMs: window.endMs })), decodeMs: 20, silence: false };
  } };
  const result = await runAudio(loadSong(), new MemoryLogger(), { file }, { mode: "AUTO", windowMs: 1000, stepMs: 500, transcriber });
  assert.equal(result.report.frames.at(-1)?.displayedSlideId, "s2");
  assert.equal(result.timing.audioDurationMs, 2500);
  assert.equal(result.timing.windowCount, 5);
  saveAudioRun(result, directory);
  const saved = loadScenario(join(directory, "transcript-replay.json"), loadSong());
  assert.equal(saved.transcriptWindowMs, 1000);
  const replayed = await replay(loadSong(), saved, new MemoryLogger());
  assert.deepEqual(replayed.transitions, result.report.transitions);
  assert.equal(JSON.parse(await readFile(join(directory, "report.json"), "utf8")).timing.windowCount, 5);
});

test("recorded audio input failure is surfaced and clears eligible automation", { skip: !hasFfmpeg }, async () => {
  const logger = new MemoryLogger();
  await assert.rejects(runAudio(loadSong(), logger, { file: "/nonexistent/song.wav" }, {
    transcriber: { async transcribe() { throw new Error("should not reach ASR"); } }, mode: "AUTO",
  }), /Audio input failed/);
  assert.ok(logger.events.some(event => event.event === "audio_failed"));
  const last = logger.events.filter(event => event.event === "follower_decision").at(-1)!;
  assert.equal(last.data.healthy, false);
  assert.equal(last.data.displayedSlideId, "s1");
});
