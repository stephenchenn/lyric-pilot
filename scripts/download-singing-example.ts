import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { runProcess } from "../src/audio/process.ts";

const directory = resolve("artifacts/singing-example");
const original = resolve(directory, "Amazing_Grace_US_Marine_Band.ogg");
const url = "https://upload.wikimedia.org/wikipedia/commons/2/21/Amazing_Grace_US_Marine_Band.ogg";
await mkdir(directory, { recursive: true });
if (!existsSync(original)) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Recording download failed: HTTP ${response.status}`);
  await writeFile(original, Buffer.from(await response.arrayBuffer()));
}
const hash = createHash("sha1").update(await readFile(original)).digest("hex");
if (hash !== "17e74a4ef3bd1dc19e77e84ec582cce8d397a262") throw new Error("Downloaded recording does not match the documented Wikimedia SHA-1");
await runProcess(process.env.FFMPEG_BIN || "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-ss", "29", "-i", original, "-t", "45", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-y", resolve(directory, "first-verse.wav")]);
// Independent published captions, not Whisper output. Times are approximate annotations.
await writeFile(resolve(directory, "ground-truth.json"), JSON.stringify([
  { atMs: 0, slideId: "ag1" }, { atMs: 10540, slideId: "ag2" },
  { atMs: 21413, slideId: "ag3" }, { atMs: 32536, slideId: "ag4" },
], null, 2) + "\n");
await writeFile(resolve(directory, "metadata.json"), JSON.stringify({
  title: "Amazing Grace — United States Marine Band, soloist Gunnery Sgt. Sara Sheffield, 2016-10-26",
  source: "https://commons.wikimedia.org/wiki/File:Amazing_Grace_US_Marine_Band.ogg",
  license: "Public domain: official US federal performance/recording and arrangement; John Newton lyrics are public domain. See source for notices.",
  captions: "https://commons.wikimedia.org/wiki/TimedText:Amazing_Grace_US_Marine_Band.ogg.en.srt",
  excerptStartMs: 29000, excerptDurationMs: 45000, sha1: hash,
  annotationLimitation: "Caption starts approximate lyric onset; not sample-accurate congregation slide cues. No recording or transcript is fed to the lyric matcher except model observations.",
}, null, 2) + "\n");
console.log(`Downloaded public-domain singing example and extracted first verse: ${directory}/first-verse.wav`);
