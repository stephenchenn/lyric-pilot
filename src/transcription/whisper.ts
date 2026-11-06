import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, availableParallelism } from "node:os";
import { basename, join, resolve } from "node:path";
import { runProcess } from "../audio/process.ts";
import { encodeWav, type AudioWindow } from "../audio/pcm.ts";
import type { RecognizedWord } from "./types.ts";

export interface Transcription { text: string; words: RecognizedWord[]; decodeMs: number; silence: boolean }
export interface WindowTranscriber {
  readonly metadata?: Record<string, string | number>;
  transcribe(window: AudioWindow, signal?: AbortSignal): Promise<Transcription>;
}

/** Parses actual whisper.cpp CLI JSON, not text printed to stderr. */
export function parseWhisperJson(value: unknown, window: AudioWindow): Omit<Transcription, "decodeMs" | "silence"> {
  if (!value || typeof value !== "object" || !Array.isArray((value as { transcription?: unknown }).transcription)) throw new Error("Whisper JSON is missing transcription array");
  const words: RecognizedWord[] = [];
  const segments = (value as { transcription: unknown[] }).transcription;
  for (const value of segments) {
    if (!value || typeof value !== "object") throw new Error("Invalid Whisper segment");
    const segment = value as { text?: unknown; offsets?: { from?: unknown; to?: unknown } };
    if (typeof segment.text !== "string" || typeof segment.offsets?.from !== "number" || typeof segment.offsets.to !== "number" ||
      !Number.isFinite(segment.offsets.from) || !Number.isFinite(segment.offsets.to) || segment.offsets.from < 0 || segment.offsets.to < segment.offsets.from) throw new Error("Invalid Whisper segment text/offsets");
    const text = segment.text.replace(/\[[^\]]*\]|\([^)]*(?:music|silence|applause)[^)]*\)/gi, " ").trim();
    if (!text) continue;
    const parts = text.split(/\s+/);
    const start = Math.min(window.endMs, window.startMs + segment.offsets.from);
    const end = Math.min(window.endMs, window.startMs + segment.offsets.to);
    parts.forEach((text, index) => words.push({ text, startMs: start + (end - start) * index / parts.length, endMs: start + (end - start) * (index + 1) / parts.length }));
  }
  return { text: words.map(word => word.text).join(" "), words };
}

export class WhisperCppTranscriber implements WindowTranscriber {
  readonly #binary: string;
  readonly #model: string;
  readonly #language: string;
  readonly #threads: number;
  constructor(options: { binary?: string; model?: string; language?: string; threads?: number } = {}) {
    this.#binary = resolve(options.binary || process.env.WHISPER_BIN || ".local/whisper.cpp/build/bin/whisper-cli");
    this.#model = resolve(options.model || process.env.WHISPER_MODEL || ".local/whisper.cpp/models/ggml-tiny.en.bin");
    this.#language = options.language || process.env.WHISPER_LANGUAGE || "en";
    this.#threads = options.threads ?? Math.min(4, availableParallelism());
    if (!Number.isInteger(this.#threads) || this.#threads < 1 || this.#threads > 32) throw new Error("Whisper threads must be 1–32");
    if (!existsSync(this.#binary) || !existsSync(this.#model)) throw new Error("Local Whisper is missing. Run npm run setup:whisper or set WHISPER_BIN and WHISPER_MODEL");
  }

  get metadata(): Record<string, string | number> {
    return { provider: "whisper.cpp CLI", model: basename(this.#model), language: this.#language, threads: this.#threads };
  }

  async transcribe(window: AudioWindow, signal?: AbortSignal): Promise<Transcription> {
    if (window.rms < 0.006) return { text: "", words: [], decodeMs: 0, silence: true };
    const directory = await mkdtemp(join(tmpdir(), "lyric-pilot-whisper-"));
    const started = performance.now();
    try {
      const input = join(directory, "window.wav"), output = join(directory, "result");
      await writeFile(input, encodeWav(window.pcm), { mode: 0o600 });
      await runProcess(this.#binary, ["-m", this.#model, "-f", input, "-l", this.#language, "-t", String(this.#threads), "-ng", "-oj", "-of", output, "-np", "-ml", "1", "-sow", "-nf"], {
        ...(signal ? { signal } : {}), timeoutMs: 120_000,
      });
      const result = parseWhisperJson(JSON.parse(await readFile(`${output}.json`, "utf8")), window);
      return { ...result, decodeMs: Math.round(performance.now() - started), silence: !result.text };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
