import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { availableParallelism } from "node:os";

// An explicit upstream release, not a moving branch. Audio inference stays local.
const root = resolve(".local/whisper.cpp");
const model = process.argv[2] || "tiny.en";
if (!/^(?:tiny|base|small|medium)(?:\.en)?$|^large-v3(?:-turbo)?$/.test(model)) throw new Error("Choose tiny[.en], base[.en], small[.en], medium[.en], large-v3 or large-v3-turbo");
async function run(command: string, args: string[], cwd = process.cwd()): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

try {
  mkdirSync(resolve(".local"), { recursive: true });
  if (!existsSync(root)) await run("git", ["clone", "--depth", "1", "--branch", "v1.9.5", "https://github.com/ggml-org/whisper.cpp.git", root]);
  if (!existsSync(resolve(root, "build/bin/whisper-cli"))) {
    await run("cmake", ["-S", root, "-B", resolve(root, "build"), "-DCMAKE_BUILD_TYPE=Release", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF", "-DGGML_NATIVE=ON"]);
    await run("cmake", ["--build", resolve(root, "build"), "--target", "whisper-cli", "--parallel", String(Math.min(4, availableParallelism()))]);
  }
  const modelPath = resolve(root, `models/ggml-${model}.bin`);
  if (!existsSync(modelPath) || statSync(modelPath).size < 1_048_576) {
    // Vendor download scripts can leave an empty/partial file if interrupted.
    // Only publish the model at its final path after a successful complete download.
    const temporary = mkdtempSync(resolve(root, "models/.download-"));
    try {
      await run("bash", ["models/download-ggml-model.sh", model, temporary], root);
      const downloaded = resolve(temporary, `ggml-${model}.bin`);
      const header = Buffer.alloc(4), descriptor = openSync(downloaded, "r");
      try { readSync(descriptor, header, 0, 4, 0); } finally { closeSync(descriptor); }
      if (statSync(downloaded).size < 1_048_576 || header.toString("ascii") !== "lmgg") throw new Error("Downloaded model is incomplete or invalid");
      renameSync(downloaded, modelPath);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  console.log(`Local Whisper ready: ${model}. Set WHISPER_MODEL=.local/whisper.cpp/models/ggml-${model}.bin to select it (default tiny.en).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
