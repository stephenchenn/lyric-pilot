import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { runProcess } from "../src/audio/process.ts";

const profile = process.argv[2] ?? "music";
if (!["music", "small"].includes(profile) || process.argv.length > 3) throw new Error("Usage: npm run setup:ctc -- music|small");
const root = resolve(".local/guided-ctc");
const python = resolve(root, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
await mkdir(root, { recursive: true });
if (!existsSync(python)) await runProcess(process.platform === "win32" ? "python" : "python3", ["-m", "venv", resolve(root, "venv")]);
const pip = ["-m", "pip", "install", "--timeout", "180", "--retries", "5"];
await runProcess(python, [...pip, "numpy==2.2.6"], { timeoutMs: 600_000 });
if (profile === "music") {
  await runProcess(python, [...pip, "torch==2.6.0", ...(process.platform === "darwin" ? [] : ["--index-url", "https://download.pytorch.org/whl/cpu"])], { timeoutMs: 600_000 });
  await runProcess(python, [...pip, "transformers==4.57.6"], { timeoutMs: 600_000 });
} else await runProcess(python, [...pip, "onnxruntime==1.23.2"], { timeoutMs: 600_000 });

const spec = profile === "music" ? {
  directory: "music", model: "mrfakename/w2v-bert-2.0-music-lyrics-ctc",
  revision: "1be91455793f86de803ac0707303a0998e423ce1", weight: "model.safetensors",
  sha256: "4293e75411c7fca47d553a0237fefe37694bf004253e9e4fe6fd7c84483d5b9d",
  files: ["config.json", "preprocessor_config.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.json", "README.md", "model.safetensors"],
  license: "MIT", limitation: "Music-trained multilingual encoder; this follower currently supports English lyrics only.",
} : {
  directory: "model", model: "Xenova/wav2vec2-base-960h",
  revision: "a19f851b3d42865797e410752b4c570c871e4825", weight: "model_quantized.onnx",
  sha256: "cd5040c147381580ed73258143dd8e0c28e800a09e74ee42ee2b3e8cb4d760a3",
  files: ["vocab.json", "model_quantized.onnx"],
  license: "Apache-2.0", limitation: "English speech acoustic model; less reliable on singing with a band.",
};
const directory = resolve(root, spec.directory);
await mkdir(directory, { recursive: true });
for (const filename of spec.files) {
  const destination = resolve(directory, filename);
  if (!existsSync(destination)) {
    console.log(`Downloading ${spec.model}/${filename}…`);
    const url = `https://huggingface.co/${spec.model}/resolve/${spec.revision}/${filename.endsWith(".onnx") ? "onnx/" : ""}${filename}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(3_600_000) });
    if (!response.ok || !response.body) throw new Error(`CTC download failed: HTTP ${response.status}`);
    async function* chunks() {
      const reader = response.body!.getReader();
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; }
      } finally { reader.releaseLock(); }
    }
    await pipeline(chunks(), createWriteStream(destination + ".part"));
    await rename(destination + ".part", destination);
  }
  if (filename === spec.weight) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    if (hash.digest("hex") !== spec.sha256) throw new Error(`CTC model hash mismatch: ${destination}`);
  }
}
await writeFile(resolve(directory, "source.json"), JSON.stringify({
  profile, model: spec.model, revision: spec.revision, sha256: spec.sha256,
  license: spec.license, modelCard: `https://huggingface.co/${spec.model}`, limitation: spec.limitation,
}, null, 2) + "\n");
console.log(`Planned acoustic model ready (${profile}): ${directory}`);
