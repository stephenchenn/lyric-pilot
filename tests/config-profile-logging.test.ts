import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/app/config.ts";
import { atPointer, expandBody, expandPath, loadProfile, parseProfile } from "../src/propresenter/profile.ts";
import { JsonlLogger, safePath } from "../src/logging/logger.ts";
import { fixtureProfile } from "./helpers.ts";

test("configuration starts in mock mode and requires an explicit live port", () => {
  assert.equal(loadConfig({}).adapter, "mock");
  assert.equal(loadConfig({}).baseUrl, null);
  assert.throws(() => loadConfig({ PROPRESENTER_ADAPTER: "http" }), /PROPRESENTER_PORT/);
  assert.equal(loadConfig({ PROPRESENTER_ADAPTER: "http", PROPRESENTER_PORT: "5555" }).baseUrl, "http://127.0.0.1:5555");
  assert.throws(() => loadConfig({ POLL_INTERVAL_MS: "0" }), /between/);
  assert.throws(() => loadConfig({ REQUEST_TIMEOUT_MS: "abc" }), /integer/);
  assert.throws(() => loadConfig({ PROPRESENTER_ADAPTER: "auto" }), /mock or http/);
  assert.throws(() => loadConfig({ PROPRESENTER_ADAPTER: "http", PROPRESENTER_PORT: "65536" }), /between/);
  assert.throws(() => loadConfig({ PROPRESENTER_ADAPTER: "http", PROPRESENTER_PORT: "55", PROPRESENTER_HOST: "user@host/path" }), /hostname/);
});

test("unverified endpoint templates are unusable, with actionable diagnostics", () => {
  assert.throws(() => loadProfile(new URL("../profiles/propresenter.example.json", import.meta.url).pathname), /unverified/);
  const profile = fixtureProfile();
  assert.equal(profile.indexBase, 1);
  assert.throws(() => parseProfile({ ...profile, schemaVersion: 2 }), /schemaVersion/);
  const badPath = structuredClone(profile);
  badPath.endpoints.triggerSlide.path = "//another-host/trigger";
  assert.throws(() => parseProfile(badPath), /single/);
  const badPointer = structuredClone(profile);
  badPointer.mapping.presentation.id = "not-a-pointer";
  assert.throws(() => parseProfile(badPointer), /JSON Pointer/);
});

test("JSON Pointers and templates handle escaping without guessing missing fields", () => {
  assert.equal(atPointer({ "a/b": { "~key": 42 } }, "/a~1b/~0key"), 42);
  assert.equal(atPointer(null, ""), null);
  assert.throws(() => atPointer({}, "/missing"), /does not contain/);
  assert.equal(expandPath("/presentation/{presentationId}/slides/{slideId}", { presentationId: "a/b", slideId: "s 2" }), "/presentation/a%2Fb/slides/s%202");
  assert.throws(() => expandPath("/{missing}", {}), /Missing/);
  assert.throws(() => expandPath("/{slideId}", { slideId: ".." }), /Dot segments/);
  assert.deepEqual(expandBody({ index: "{index}", id: "{slideId}", nested: ["slide {index}"] }, { index: 3, slideId: "s3" }), {
    index: 3, id: "s3", nested: ["slide 3"],
  });
});

test("JSONL diagnostics redact credentials and retain useful response data", t => {
  const directory = mkdtempSync(join(tmpdir(), "lyric-pilot-logs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "events.jsonl");
  const logger = new JsonlLogger(path, ["known-secret"]);
  logger.log("http_response", { body: { title: "Synthetic song", access_token: "secret", nested: [{ Authorization: "Bearer secret" }], raw: "echoed known-secret" } });
  const line = readFileSync(path, "utf8").trim();
  const parsed = JSON.parse(line);
  assert.equal(parsed.event, "http_response");
  assert.equal(parsed.body.title, "Synthetic song");
  assert.equal(parsed.body.access_token, "[REDACTED]");
  assert.equal(parsed.body.raw, "echoed [REDACTED]");
  assert.equal(line.includes("secret"), false);
  assert.equal(safePath("/state?token=hidden&view=live").includes("hidden"), false);
  logger.log("canonical-event", { event: "must-not-overwrite" });
  assert.equal(JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!).event, "canonical-event");
});
