import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadSong } from "../src/song/model.ts";
import { syntheticScenarios } from "../src/replay/scenarios.ts";
import { runProcess } from "../src/audio/process.ts";
import { encodeWav } from "../src/audio/pcm.ts";

// An audible, reproducible spoken-audio smoke test. It is not a singing benchmark.
const song = loadSong();
const name = process.argv[2] || "jump-bridge";
const scenario = syntheticScenarios(song).find(scenario => scenario.name === name);
if (!scenario) throw new Error("Choose a synthetic scenario: normal, extra-chorus, skip-chorus, jump-bridge, return-verse, noisy-transcript, vocal-dropout, manual-correction");
const directory = resolve("artifacts/synthetic-audio", name);
await mkdir(directory, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "lyric-pilot-voice-"));
try {
  const clips = new Map<string, Buffer>();
  for (const slideId of new Set(scenario.groundTruth.map(point => point.slideId))) {
    const textPath = join(temporary, `${slideId}.txt`), pcmPath = join(temporary, `${slideId}.pcm`);
    await writeFile(textPath, song.slides.find(slide => slide.id === slideId)!.text);
    await runProcess(process.env.FFMPEG_BIN || "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `flite=textfile=${textPath}:voice=slt`, "-af", "adelay=250,apad", "-t", "4.5", "-ar", "16000", "-ac", "1", "-f", "s16le", "-y", pcmPath]);
    clips.set(slideId, await readFile(pcmPath));
  }
  const audio: Buffer[] = [];
  for (let index = 0; index < scenario.groundTruth.length; index++) {
    const point = scenario.groundTruth[index]!;
    const end = scenario.groundTruth[index + 1]?.atMs ?? scenario.durationMs;
    const clip = clips.get(point.slideId)!;
    audio.push(clip);
    const extraMs = end - point.atMs - 4500;
    if (extraMs > 0) audio.push(Buffer.alloc(extraMs * 32));
  }
  await writeFile(join(directory, "performance.wav"), encodeWav(Buffer.concat(audio)));
  await writeFile(join(directory, "ground-truth.json"), JSON.stringify(scenario.groundTruth.map((point, index) => ({ ...point, atMs: point.atMs + (index ? 250 : 0) })), null, 2) + "\n");
  await writeFile(join(directory, "metadata.json"), JSON.stringify({
    scenario: name, provenance: "Original synthetic lyrics spoken by FFmpeg/libflite slt, with 250ms leading silence per line. No lyric text supplied to Whisper.",
    limitation: "Spoken synthetic speech, not a human singing or a band recording. Transcript-noise/manual events are not synthesized into audio.",
    durationMs: scenario.durationMs,
  }, null, 2) + "\n");
  console.log(`Generated spoken original-lyric recording: ${directory}/performance.wav`);
} finally { await rm(temporary, { recursive: true, force: true }); }
