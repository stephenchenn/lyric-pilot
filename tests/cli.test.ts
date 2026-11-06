import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile);
const entry = new URL("../src/app/main.ts", import.meta.url).pathname;
const follower = new URL("../src/app/follow.ts", import.meta.url).pathname;

test("CLI JSON status is usable and demo always stays in mock mode", async t => {
  const directory = mkdtempSync(join(tmpdir(), "lyric-pilot-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, PROPRESENTER_ADAPTER: "mock", LOG_FILE: join(directory, "events.jsonl") };
  const status = await exec(process.execPath, [entry, "status", "--json"], { env });
  const snapshot = JSON.parse(status.stdout);
  assert.equal(snapshot.health.status, "connected");
  assert.equal(snapshot.currentSlide.id, "s1");
  assert.equal(status.stderr, "");
  const demo = await exec(process.execPath, [entry, "demo"], { env: { ...env, PROPRESENTER_ADAPTER: "http" } });
  assert.match(demo.stdout, /NEXT → slide 2/);
  assert.match(demo.stdout, /Expected refusal: Control blocked/);
  assert.match(demo.stderr, /Adapter: MOCK/);
});

test("follower CLI ranks lyrics and exports scenario benchmarks without a ProPresenter instance", async t => {
  const directory = mkdtempSync(join(tmpdir(), "lyric-pilot-follow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const matched = await exec(process.execPath, [follower, "match", "we will follow we will follow", "--current", "s6", "--json", "--output", directory]);
  assert.equal(JSON.parse(matched.stdout).candidates[0].slideId, "s7");
  const benchmark = await exec(process.execPath, [follower, "demo", "--json", "--output", directory]);
  const results = JSON.parse(benchmark.stdout);
  assert.equal(results.length, 8);
  assert.ok(results.every((result: { metrics: { missedTransitions: number; falseTransitions: number } }) => result.metrics.missedTransitions === 0 && result.metrics.falseTransitions === 0));
  const replayed = await exec(process.execPath, [follower, "replay", "jump-bridge", "--quiet", "--json", "--output", directory]);
  assert.equal(JSON.parse(replayed.stdout).metrics.matchedTransitions, 5);
});

test("CLI rejects unknown commands and unverified live profiles clearly", async t => {
  const directory = mkdtempSync(join(tmpdir(), "lyric-pilot-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, LOG_FILE: join(directory, "events.jsonl") };
  await assert.rejects(exec(process.execPath, [entry, "auto"], { env }), error => {
    assert.match(String((error as { stderr: string }).stderr), /Unknown command auto/);
    return true;
  });
  await assert.rejects(exec(process.execPath, [entry, "status", "--adapter", "http", "--port", "1", "--profile",
    new URL("../profiles/propresenter.example.json", import.meta.url).pathname], { env }), error => {
    assert.match(String((error as { stderr: string }).stderr), /profile is unverified/);
    return true;
  });
});
