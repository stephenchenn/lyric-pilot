import { parseArgs } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { loadSong } from "../song/model.ts";
import { LyricFollower, type FollowerFrame } from "../follower/engine.ts";
import { formatFrame, formatMetrics, clock, percentage } from "../follower/display.ts";
import { JsonlLogger } from "../logging/logger.ts";
import type { FollowerEvent, OperatingMode } from "../transcription/types.ts";
import { loadScenario, replay } from "../replay/replay.ts";
import { syntheticScenarios } from "../replay/scenarios.ts";
import { renderTimeline } from "../replay/timeline.ts";
import { runAudio, saveAudioRun } from "../audio/run.ts";
import { runPlannedAudio, savePlannedRun } from "../audio/planned.ts";
import { parsePlannedReplay, replayPlanned } from "../replay/planned.ts";

const help = `Lyric Pilot · local follower simulator · NEVER controls real ProPresenter

Usage: npm run follow -- [command] [argument] [options]

  console                 Type lyric phrases and inspect tracking (default)
  match "lyric phrase"     Rank candidates without changing state
  demo                    Benchmark eight deterministic transcript scenarios
  replay <name|file.json>  Play a saved transcript scenario
  audio <file>            Transcribe recorded audio through the follower
  transcribe <file>       Save transcription/replay; print recognized text
  listen                  Capture an explicitly requested PulseAudio input

  --song <song.json>       Import a song (default: original synthetic song)
  --arrangement "V1->C"    Override planned section order
  --current <slide-id>     Initial slide for console/match
  --mode assist|auto|manual  AUTO changes simulated output only
  --speed <number>         Transcript replay rate; 0 = immediate (default)
  --window-ms <number>     Audio window (Whisper 5000; planned 1500)
  --step-ms <number>       Audio decode interval (Whisper 1500; planned 500)
  --truth <file.json>      Ground-truth [{atMs,slideId}] for audio evaluation
  --output <directory>    Reports/transcript exports (default artifacts/follower)
  --realtime              Pace file audio as a performance
  --play                  Play recorded audio with ffplay; implies --realtime
  --device <name>          PulseAudio input (default default)
  --planned               Follow fixed lyric words (audio/listen/replay)
  --acoustic-model music|small  Planned acoustic profile (default music)
  --quiet                 Print only transitions and summary
  --diagnostics           Include tracking, candidate scores and decision details
  --json                  Machine-readable match/demo/replay output
  --help                  Show this help

Console: enter lyrics, partial <id> <text>, final <id> <text>,
  mode assist|auto|manual, manual <slide-id> [zero-based-step], pause,
  resume, status, next, previous, tick <ms>, quit

Audio prerequisites: ffmpeg; npm run setup:whisper (or setup:ctc for --planned).
No API keys, audio uploads or Windows machine required.
`;

function mode(value: string | undefined, fallback: OperatingMode = "ASSIST"): OperatingMode {
  const parsed = (value ?? fallback).toUpperCase();
  if (parsed !== "MANUAL" && parsed !== "ASSIST" && parsed !== "AUTO") throw new Error("Mode must be manual, assist or auto");
  return parsed;
}
function number(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Expected a finite nonnegative number");
  return parsed;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    song: { type: "string" }, arrangement: { type: "string" }, current: { type: "string" }, mode: { type: "string" },
    speed: { type: "string" }, "window-ms": { type: "string" }, "step-ms": { type: "string" },
    truth: { type: "string" }, output: { type: "string" }, device: { type: "string" },
    "acoustic-model": { type: "string" },
    realtime: { type: "boolean" }, play: { type: "boolean" }, planned: { type: "boolean" }, quiet: { type: "boolean" }, diagnostics: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(help); return; }
  const [command = "console", argument] = positionals;
  if (!["console", "match", "demo", "replay", "audio", "transcribe", "listen"].includes(command)) throw new Error("Unknown command; use --help");
  if (values.planned && !["audio", "listen", "replay"].includes(command)) throw new Error("--planned is supported by audio, listen and replay");
  const acousticModel = values["acoustic-model"];
  if (acousticModel && (!values.planned || !["audio", "listen"].includes(command) || !["music", "small"].includes(acousticModel))) throw new Error("--acoustic-model requires planned audio/listen and must be music or small");
  const requiresArgument = ["match", "replay", "audio", "transcribe"].includes(command);
  if ((requiresArgument && !argument) || positionals.length > (requiresArgument ? 2 : 1)) throw new Error("Invalid command arguments; use --help");
  if (existsSync(".env")) loadEnvFile(".env");
  const displayOptions = {
    diagnostics: values.diagnostics === true,
    color: process.stdout.isTTY === true && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb",
  };
  const song = loadSong(values.song, values.arrangement);
  const output = resolve(values.output || "artifacts/follower");
  mkdirSync(output, { recursive: true });
  const logger = new JsonlLogger(resolve(output, `session-${Date.now()}-${process.pid}.jsonl`));
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  if (!values.json) console.error(`SIMULATOR · ${song.title} · no ProPresenter connection · logs ${logger.path}`);
  try {
    if (command === "match") {
      const engine = new LyricFollower(song, logger, { mode: "MANUAL", ...(values.current ? { initialSlideId: values.current } : {}) });
      const frame = engine.observe({ type: "transcript", id: "typed", startMs: 0, endMs: 0, atMs: 0, text: argument!, final: true });
      console.log(values.json ? JSON.stringify(frame, null, 2) : formatFrame(frame, song, { ...displayOptions, diagnostics: true }));
    } else if (command === "replay" && values.planned) {
      const result = await replayPlanned(song, parsePlannedReplay(JSON.parse(readFileSync(argument!, "utf8"))), logger, {
        mode: mode(values.mode, "AUTO"), speed: number(values.speed, 0), signal: abort.signal,
        ...(values.truth ? { truthPath: values.truth } : {}),
        onFrame: frame => {
          if (values.json) return;
          if (!values.quiet) console.log(formatFrame(frame, song, displayOptions));
          else if (frame.decision.accepted) console.log(`${clock(frame.atMs)} ${frame.lastAction}`);
        },
      });
      writeFileSync(resolve(output, "report.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
      writeFileSync(resolve(output, "timeline.svg"), renderTimeline(result), { mode: 0o600 });
      console.log(values.json ? JSON.stringify(result, null, 2) : `\n${formatMetrics(result.metrics)}`);
    } else if (command === "demo" || command === "replay") {
      const scenarios = command === "demo" ? syntheticScenarios(song) : [loadScenario(existsSync(argument!) ? argument! : resolve("data/replays", `${argument}.json`), song)];
      const results = [];
      for (const scenario of scenarios) {
        const result = await replay(song, scenario, logger, {
          mode: mode(values.mode, "AUTO"), speed: number(values.speed, 0), signal: abort.signal,
          onFrame: frame => {
            if (command === "replay" && !values.json && !values.quiet) console.log(formatFrame(frame, song, displayOptions));
            else if (command === "replay" && !values.json && values.quiet && frame.decision.accepted) console.log(`${clock(frame.atMs)} ${frame.lastAction}`);
          },
        });
        writeFileSync(resolve(output, `${scenario.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`), JSON.stringify(result, null, 2) + "\n");
        writeFileSync(resolve(output, `${scenario.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.svg`), renderTimeline(result));
        results.push(result);
        if (!values.json) console.log(`\n${scenario.name}\n${formatMetrics(result.metrics)}`);
      }
      if (values.json) console.log(JSON.stringify(command === "demo" ? results.map(({ name, metrics }) => ({ name, metrics })) : results[0], null, 2));
    } else if (command === "audio" || command === "transcribe" || command === "listen") {
      const startPlayer = () => {
        const child = values.play && argument ? spawn("ffplay", ["-nodisp", "-autoexit", "-loglevel", "error", resolve(argument)], { stdio: "ignore" }) : null;
        child?.once("error", error => console.error(`Audio playback unavailable: ${error.message}`));
        return child;
      };
      let player = values.planned ? null : startPlayer();
      try {
        const input = command === "listen" ? { device: values.device || "default" } : { file: argument! };
        const options = {
          mode: mode(values.mode), windowMs: number(values["window-ms"], values.planned ? 1500 : 5000), stepMs: number(values["step-ms"], values.planned ? 500 : 1500),
          realtime: command === "listen" || values.realtime === true || values.play === true, signal: abort.signal,
          ...(values.truth ? { truthPath: values.truth } : {}),
          ...(acousticModel ? { acousticModel: acousticModel as "music" | "small" } : {}),
          onFrame: (frame: FollowerFrame) => {
            if (values.json) return;
            if (command === "transcribe") { if (frame.inputType === "transcript") console.log(`${clock(frame.atMs)} ${frame.transcript || "(silence)"}`); }
            else if (!values.quiet) console.log(formatFrame(frame, song, displayOptions));
            else if (frame.decision.accepted) console.log(`${clock(frame.atMs)} ${frame.lastAction}`);
          },
        };
        const result = values.planned ? await runPlannedAudio(song, logger, input, { ...options, onReady: () => { player = startPlayer(); } }) : await runAudio(song, logger, input, options);
        if ("observations" in result) savePlannedRun(result, output);
        else saveAudioRun(result, output);
        if (values.json) console.log(JSON.stringify({ metrics: result.report.metrics, timing: result.timing }, null, 2));
        else console.log(`\n${formatMetrics(result.report.metrics)}\nAudio ${result.timing.audioDurationMs.toFixed(0)}ms · decode ${result.timing.decodingMs}ms · decode/audio ${percentage(result.timing.decodeToAudioRatio)} · max availability lag ${result.timing.maximumBacklogMs}ms\nSaved ${resolve(output, "observations" in result ? "guided-replay.json" : "transcript-replay.json")}`);
      } finally { player?.kill("SIGKILL"); }
    } else {
      const engine = new LyricFollower(song, logger, { mode: mode(values.mode), ...(values.current ? { initialSlideId: values.current } : {}) });
      let atMs = 0, serial = 0;
      const started = performance.now(), utteranceStarts = new Map<string, number>();
      const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true, signal: abort.signal });
      console.log(formatFrame(engine.observe({ type: "tick", atMs: 0 }), song, displayOptions));
      console.log("\nType lyrics or help. AUTO only changes the simulated display.");
      terminal.setPrompt("follow> "); terminal.prompt();
      try {
        for await (const line of terminal) {
          atMs = Math.max(atMs, Math.round(performance.now() - started));
          const [first, ...args] = line.trim().split(/\s+/);
          if (!first) { terminal.prompt(); continue; }
          if (first === "quit" || first === "exit") break;
          try {
            let event: FollowerEvent;
            if (first === "help") { console.log(help); terminal.prompt(); continue; }
            if (first === "mode") event = { type: "mode", atMs, mode: mode(args[0]) };
            else if (first === "pause" || first === "resume") event = { type: "pause", atMs, paused: first === "pause" };
            else if (first === "manual") event = { type: "manual", atMs, slideId: args[0] ?? "", ...(args[1] ? { stepIndex: number(args[1], 0) } : {}) };
            else if (first === "next" || first === "previous") {
              const index = song.slides.findIndex(slide => slide.id === engine.tracker.current.slideId);
              const slide = song.slides[index + (first === "next" ? 1 : -1)];
              if (!slide) throw new Error("Presentation boundary");
              event = { type: "manual", atMs, slideId: slide.id };
            } else if (first === "tick" || first === "status") {
              if (first === "tick") atMs += number(args[0], 0);
              event = { type: "tick", atMs };
            } else {
              const editable = first === "partial" || first === "final";
              const id = editable ? args.shift() : `typed-${serial++}`;
              if (!id) throw new Error("partial/final requires an utterance ID and text");
              const text = editable ? args.join(" ") : line.trim();
              if (!text) throw new Error("Transcript text is empty");
              const startMs = utteranceStarts.get(id) ?? atMs;
              utteranceStarts.set(id, startMs);
              event = { type: "transcript", id, startMs, endMs: atMs, atMs, text, final: first !== "partial" };
            }
            console.log(formatFrame(engine.observe(event), song, displayOptions));
          } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
          terminal.prompt();
        }
      } finally { terminal.close(); }
    }
  } finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}

await main().catch(error => {
  console.error(`Lyric Pilot follower: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
