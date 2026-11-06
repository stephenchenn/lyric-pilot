import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { encodeWav, type AudioWindow } from "../audio/pcm.ts";
import type { AcousticObservation } from "../lyrics/planned.ts";

export interface CtcVocabulary { labels: string[]; blank: number; model?: { path: string; sha256: string; backend?: string; runtimeVersion?: string } }
export type AcousticProfile = "music" | "small";
export interface AcousticTranscriber {
  ready(): Promise<CtcVocabulary>;
  transcribe(window: AudioWindow, signal?: AbortSignal): Promise<AcousticObservation>;
  close(): void;
}

/** Persistent local acoustic worker. Only PCM goes in; no expected lyrics or timings. */
export class CtcTranscriber implements AcousticTranscriber {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #ready: Promise<CtcVocabulary>;
  readonly #pending = new Map<number, { resolve: (value: Omit<AcousticObservation, "startMs" | "endMs">) => void; reject: (error: Error) => void }>();
  #serial = 0;
  #closed = false;

  constructor(options: { profile?: AcousticProfile } = {}) {
    const python = resolve(process.env.CTC_PYTHON || `.local/guided-ctc/venv/${process.platform === "win32" ? "Scripts/python.exe" : "bin/python"}`);
    const profile = options.profile ?? "music";
    const override = options.profile === undefined ? process.env.CTC_MODEL : undefined;
    const model = resolve(override || (profile === "music" ? ".local/guided-ctc/music/model.safetensors" : ".local/guided-ctc/model/model_quantized.onnx"));
    const vocab = resolve(options.profile === undefined && process.env.CTC_VOCAB || join(dirname(model), "vocab.json"));
    if (![python, model, vocab].every(path => existsSync(path))) throw new Error(`Planned acoustic model is missing. Run npm run setup:ctc -- ${profile} first.`);
    this.#child = spawn(python, ["-u", new URL("../../scripts/ctc_worker.py", import.meta.url).pathname, "--model", model, "--vocab", vocab, "--threads", "4"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    this.#child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-16_384); });
    this.#ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error("CTC worker startup timed out")); this.close(); }, 60_000);
      const fail = (error: Error) => {
        clearTimeout(timeout); reject(error);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
      };
      this.#child.once("error", fail);
      this.#child.stdin.on("error", fail);
      this.#child.once("close", code => fail(new Error(`CTC worker exited ${code}: ${stderr.trim()}`)));
      createInterface({ input: this.#child.stdout }).on("line", line => {
        try {
          const message = JSON.parse(line);
          if (message.type === "ready") {
            if (!Array.isArray(message.labels) || !Number.isInteger(message.blank)) throw new Error("Invalid CTC worker vocabulary");
            clearTimeout(timeout); resolve({ labels: message.labels, blank: message.blank, ...(message.model ? { model: message.model } : {}) });
          } else {
            const pending = this.#pending.get(message.id);
            if (!pending) return;
            this.#pending.delete(message.id);
            if (message.type === "error") pending.reject(new Error(message.message));
            else if (message.type === "result") pending.resolve(message);
            else pending.reject(new Error("Unexpected CTC worker response"));
          }
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); this.close(); }
      });
    });
  }

  ready(): Promise<CtcVocabulary> { return this.#ready; }

  async transcribe(window: AudioWindow, signal?: AbortSignal): Promise<AcousticObservation> {
    signal?.throwIfAborted();
    const vocabulary = await this.#ready;
    if (window.rms < 0.006) {
      const frames = Math.max(1, Math.floor((window.endMs - window.startMs - 25) / 20) + 1);
      return { startMs: window.startMs, endMs: window.endMs, frameOffsetMs: 12.5, frameStepMs: 20, decodeMs: 0, text: "", logProbs: Array.from({ length: frames }, () => vocabulary.labels.map((_, id) => id === vocabulary.blank ? 0 : -20)) };
    }
    const directory = await mkdtemp(join(tmpdir(), "lyric-pilot-ctc-"));
    const started = performance.now();
    const id = this.#serial++;
    const cancel = () => this.#pending.get(id)?.reject(new Error("CTC inference cancelled"));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const file = join(directory, "input.wav");
      await writeFile(file, encodeWav(window.pcm), { mode: 0o600 });
      const result = await new Promise<Omit<AcousticObservation, "startMs" | "endMs">>((resolve, reject) => {
        if (this.#closed) { reject(new Error("CTC worker is closed")); return; }
        this.#pending.set(id, { resolve, reject });
        timeout = setTimeout(() => { reject(new Error("CTC inference timed out")); this.close(); }, 120_000);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) { cancel(); return; }
        this.#child.stdin.write(JSON.stringify({ id, file }) + "\n", error => { if (error) reject(error); });
      });
      return { ...result, startMs: window.startMs, endMs: window.endMs, decodeMs: Math.round(performance.now() - started) };
    } finally {
      signal?.removeEventListener("abort", cancel); this.#pending.delete(id);
      clearTimeout(timeout);
      await rm(directory, { recursive: true, force: true });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#child.kill("SIGKILL");
  }
}
