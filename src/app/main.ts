import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.ts";
import { JsonlLogger, redact } from "../logging/logger.ts";
import { errorMessage, type PresenterSnapshot, type ProPresenterAdapter } from "../propresenter/adapter.ts";
import { HttpClient } from "../propresenter/client.ts";
import { HttpProPresenterAdapter } from "../propresenter/http.ts";
import { MockProPresenterAdapter } from "../propresenter/mock.ts";
import { loadProfile } from "../propresenter/profile.ts";
import { PresenterSession, type ControlAction } from "../propresenter/session.ts";

const help = `Lyric Pilot — ProPresenter integration spike (MANUAL only)

Usage: npm run cli -- [command] [argument] [options]

  console             Interactive controls and background observation (default)
  status              Connection, active presentation and current slide
  watch               Poll state until Ctrl+C; recover after connection loss
  slides              List the active presentation's physical slides
  next | previous     Select an adjacent physical slide in this presentation
  goto <slide-id>     Select one known slide in the active presentation
  inspect <path>      Make one explicit GET request and print the response
  demo                Run a synthetic, deterministic integration demonstration

Options:
  --adapter mock|http  Override PROPRESENTER_ADAPTER
  --profile <file>     Installed-version API profile
  --host <host>        Override PROPRESENTER_HOST
  --port <port>        Override PROPRESENTER_PORT (no guessed default)
  --allow-control     Enable explicit live controls / arbitrary inspect GET
  --json              JSON output for status, slides or controls
  --help              Show this help

Console: status, slides, next, previous, goto <id>, resync, quit
Mock console also supports: manual <id>, disconnect, reconnect

No audio, transcription, matching or automatic controls are enabled.
`;

function summary(snapshot: PresenterSnapshot): string {
  const { health, presentation, currentSlide } = snapshot;
  return [
    `[${health.status.toUpperCase()}] ${health.message}`,
    `Presentation: ${presentation ? `${presentation.title} (${presentation.id})` : "none"}`,
    `Current slide: ${currentSlide ? `${currentSlide.index + 1} (${currentSlide.id})` : "none"}`,
  ].join("\n");
}

function actionFor(command: string, argument?: string): ControlAction {
  if (command === "next" || command === "previous") return { type: command };
  if (command === "goto" && argument) return { type: "goto", slideId: argument };
  throw new Error("Use next, previous, or goto <slide-id>");
}

async function displaySlides(session: PresenterSession, json = false): Promise<void> {
  const slides = await session.listSlides();
  console.log(json ? JSON.stringify(slides, null, 2) : slides.map(slide =>
    `${String(slide.index + 1).padStart(2)}  ${slide.id}  [${slide.section ?? "no section"}]  ${slide.text}`,
  ).join("\n"));
}

async function demo(session: PresenterSession, adapter: MockProPresenterAdapter): Promise<void> {
  console.log("MOCK DEMO · all controls are local simulations · MANUAL mode\n");
  console.log(summary(await session.connect()));
  console.log("\nEight synthetic lyric slides:");
  await displaySlides(session);
  const result = await session.control({ type: "next" });
  console.log(`\nNEXT → slide ${result.target.index + 1} (${result.target.id}); confirmed=${result.confirmed}`);
  adapter.manualSelect("s7");
  console.log("\nSimulated human selects Bridge:");
  console.log(summary(await session.refresh()));
  adapter.setConnected(false);
  console.log("\nSimulated disconnect:");
  console.log(summary(await session.refresh()));
  try { await session.control({ type: "next" }); } catch (error) {
    console.log(`Expected refusal: ${errorMessage(error)}`);
  }
  adapter.setConnected(true);
  console.log("\nConnection restored; observed state is authoritative:");
  console.log(summary(await session.refresh()));
}

async function observe(session: PresenterSession, adapter: ProPresenterAdapter, intervalMs: number, interactive: boolean): Promise<void> {
  console.log(summary(await session.connect()));
  const abort = new AbortController();
  const stop = () => { abort.abort(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const terminal = interactive ? createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true, signal: abort.signal }) : null;
  let executing = false;
  const unsubscribe = session.onSnapshot(snapshot => {
    console.log(`\n${summary(snapshot)}`);
    if (!executing) terminal?.prompt(true);
  });
  const stopPolling = session.startPolling(intervalMs);
  try {
    if (!terminal) {
      try { await delay(2_147_483_647, undefined, { signal: abort.signal }); } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
      return;
    }
    console.log("\nMANUAL mode · type help for commands · Ctrl+C to exit");
    terminal.setPrompt("lyric-pilot> ");
    terminal.prompt();
    for await (const line of terminal) {
      executing = true;
      const [command, argument, ...extra] = line.trim().split(/\s+/);
      try {
        if (extra.length || (argument && command !== "goto" && command !== "manual")) throw new Error("Too many command arguments");
        if (command === "quit" || command === "exit") break;
        if (command === "help") console.log(help);
        else if (command === "status" || command === "resync") console.log(summary(await session.refresh()));
        else if (command === "slides") await displaySlides(session);
        else if (command === "next" || command === "previous" || command === "goto") {
          const result = await session.control(actionFor(command, argument));
          console.log(`Sent ${result.target.id}; ${result.confirmed ? "confirmed" : "not yet confirmed; check observed state, do not blindly repeat"}`);
        } else if (adapter instanceof MockProPresenterAdapter && command === "manual" && argument) {
          adapter.manualSelect(argument);
          await session.refresh();
        } else if (adapter instanceof MockProPresenterAdapter && (command === "disconnect" || command === "reconnect")) {
          adapter.setConnected(command === "reconnect");
          await session.refresh();
        } else if (command) throw new Error("Unknown command; type help");
      } catch (error) { console.error(`Error: ${errorMessage(error)}`); }
      executing = false;
      terminal.prompt();
    }
  } finally {
    stopPolling();
    unsubscribe();
    terminal?.close();
    abort.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      adapter: { type: "string" }, profile: { type: "string" },
      host: { type: "string" }, port: { type: "string" },
      "allow-control": { type: "boolean", default: false },
      json: { type: "boolean", default: false }, help: { type: "boolean", default: false },
    },
  });
  if (values.help) { console.log(help); return; }
  const [command = "console", argument] = positionals;
  const commands = ["console", "status", "watch", "slides", "next", "previous", "goto", "inspect", "demo"];
  if (!commands.includes(command)) throw new Error(`Unknown command ${command}; use --help`);
  const needsArgument = command === "goto" || command === "inspect";
  if (positionals.length > (needsArgument ? 2 : 1) || (needsArgument && !argument)) {
    throw new Error(`${command} ${needsArgument ? "requires exactly one argument" : "takes no arguments"}`);
  }
  if (command !== "demo" && existsSync(".env")) loadEnvFile(".env");
  const env = { ...process.env };
  if (values.adapter) env.PROPRESENTER_ADAPTER = values.adapter;
  if (values.profile) env.PROPRESENTER_PROFILE = values.profile;
  if (values.host) env.PROPRESENTER_HOST = values.host;
  if (values.port) env.PROPRESENTER_PORT = values.port;
  if (command === "demo") env.PROPRESENTER_ADAPTER = "mock";
  const config = loadConfig(env);
  const logger = new JsonlLogger(config.logPath, config.token ? [config.token] : []);
  logger.log("session_started", { adapter: config.adapter, command, mode: "manual", baseUrl: config.baseUrl });
  if (!values.json) console.error(`Adapter: ${config.adapter.toUpperCase()} · Mode: MANUAL · Log: ${logger.path}`);

  const client = config.baseUrl ? new HttpClient(config.baseUrl, config.requestTimeoutMs, logger, config.token) : null;
  if (command === "inspect") {
    if (!client) throw new Error("inspect requires --adapter http and the installed API port");
    if (!values["allow-control"]) {
      throw new Error("GET routes can trigger ProPresenter actions. Check the installed docs and add --allow-control for this explicit request");
    }
    const result = await client.request("GET", argument!);
    console.log(JSON.stringify(redact(result, config.token ? [config.token] : []), null, 2));
    return;
  }
  const adapter: ProPresenterAdapter = client
    ? new HttpProPresenterAdapter(client, loadProfile(config.profilePath))
    : new MockProPresenterAdapter(logger);
  const session = new PresenterSession(adapter, logger, values["allow-control"]);
  try {
    if (command === "demo") await demo(session, adapter as MockProPresenterAdapter);
    else if (command === "console" || command === "watch") await observe(session, adapter, config.pollIntervalMs, command === "console");
    else if (command === "status") {
      const state = await session.connect();
      console.log(values.json ? JSON.stringify(state, null, 2) : summary(state));
      if (state.health.status !== "connected") process.exitCode = 1;
    } else if (command === "slides") await displaySlides(session, values.json);
    else {
      const result = await session.control(actionFor(command, argument));
      console.log(values.json ? JSON.stringify(result, null, 2) : `${summary(result.snapshot)}\nControl ${result.confirmed ? "confirmed" : "not yet confirmed; check state before another command"}`);
      if (!result.confirmed) process.exitCode = 1;
    }
  } finally {
    adapter.close();
    logger.log("session_stopped", { command });
  }
}

await main().catch(error => {
  console.error(`Lyric Pilot: ${errorMessage(error)}`);
  process.exitCode = 1;
});
