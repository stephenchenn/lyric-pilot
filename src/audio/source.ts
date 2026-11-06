import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** FFmpeg normalizes files or an explicitly requested PulseAudio input to PCM16/16k mono. */
export async function* capturePcm(input: { file: string; realtime?: boolean } | { device: string }, signal?: AbortSignal): AsyncGenerator<Buffer> {
  signal?.throwIfAborted();
  const source = "file" in input ? [...(input.realtime ? ["-re"] : []), "-i", resolve(input.file)] : ["-f", "pulse", "-i", input.device];
  const child = spawn(process.env.FFMPEG_BIN || "ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...source, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], {
    stdio: ["ignore", "pipe", "pipe"], ...(signal ? { signal, killSignal: "SIGKILL" as const } : {}),
  });
  let stderr = "", spawnError: Error | null = null, ended = false;
  child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-16_384); });
  const completion = new Promise<number | null>(resolve => {
    child.once("error", error => { spawnError = error; resolve(null); });
    child.once("close", code => { ended = true; resolve(code); });
  });
  try {
    for await (const chunk of child.stdout) yield chunk as Buffer;
    const code = await completion;
    if (signal?.aborted) return;
    if (spawnError) throw spawnError;
    if (code !== 0) throw new Error(`Audio input failed: ${stderr.trim() || `FFmpeg exited ${code}`}`);
  } finally {
    if (!ended) child.kill("SIGKILL");
    await completion;
  }
}
