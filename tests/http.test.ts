import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpClient } from "../src/propresenter/client.ts";
import { HttpProPresenterAdapter } from "../src/propresenter/http.ts";
import { PresenterSession } from "../src/propresenter/session.ts";
import { MemoryLogger, fixtureProfile, presenterFixture, serve } from "./helpers.ts";

test("HTTP contract maps nested responses, normalizes indices and controls one known slide", async t => {
  const fixture = await presenterFixture();
  t.after(() => fixture.close());
  const logger = new MemoryLogger();
  const adapter = new HttpProPresenterAdapter(new HttpClient(fixture.baseUrl, 1000, logger), fixtureProfile());
  const session = new PresenterSession(adapter, logger, true);
  assert.equal((await session.connect()).presentation?.id, "synthetic-presentation");
  assert.equal((await session.refresh()).currentSlide?.index, 0);
  const slides = await session.listSlides();
  assert.equal(slides[0]?.id, "s1");
  assert.equal(slides[7]?.index, 7);
  assert.equal(slides[0]?.text, "Morning breaks across the valley");
  const result = await session.control({ type: "next" });
  assert.equal(result.confirmed, true);
  assert.equal(result.target.id, "s2");
  assert.deepEqual(fixture.state.lastBody, { cue_number: 2 });
  assert.equal(fixture.state.triggerCount, 1);
  fixture.state.currentIndex = 6; // Simulated selection outside this client.
  assert.equal((await session.refresh()).currentSlide?.id, "s7");
  assert.equal((await session.control({ type: "next" })).target.id, "s8");
  assert.equal(fixture.state.triggerCount, 2);
  assert.ok(logger.events.some(item => item.event === "http_response" && item.data.status === 204));
});

test("live controls require an explicit flag and never fire on unhealthy or inconsistent state", async t => {
  const fixture = await presenterFixture();
  t.after(() => fixture.close());
  const logger = new MemoryLogger();
  const adapter = new HttpProPresenterAdapter(new HttpClient(fixture.baseUrl, 1000, logger), fixtureProfile());
  const observeOnly = new PresenterSession(adapter, logger);
  await assert.rejects(observeOnly.control({ type: "next" }), /--allow-control/);
  assert.equal(fixture.requests.length, 0);
  const session = new PresenterSession(adapter, logger, true);
  fixture.state.healthy = false;
  assert.equal((await session.refresh()).health.status, "disconnected");
  await assert.rejects(session.control({ type: "next" }), /Control blocked/);
  fixture.state.healthy = true;
  fixture.state.malformed = true;
  const malformed = await session.refresh();
  assert.equal(malformed.health.status, "degraded");
  assert.equal(malformed.currentSlide, null);
  await assert.rejects(session.control({ type: "next" }), /Control blocked/);
  fixture.state.malformed = false;
  fixture.state.mismatch = true;
  assert.match((await session.refresh()).health.message, /disagree/);
  await assert.rejects(session.control({ type: "next" }), /Control blocked/);
  fixture.state.mismatch = false;
  fixture.state.hasActivePresentation = false;
  assert.equal((await session.refresh()).presentation, null);
  await assert.rejects(session.control({ type: "next" }), /Control blocked/);
  fixture.state.hasActivePresentation = true;
  assert.equal((await session.refresh()).health.status, "connected");
  assert.equal(fixture.state.triggerCount, 0);
});

test("a rejected trigger is never retried", async t => {
  const fixture = await presenterFixture();
  t.after(() => fixture.close());
  fixture.state.failTrigger = true;
  const logger = new MemoryLogger();
  const adapter = new HttpProPresenterAdapter(new HttpClient(fixture.baseUrl, 1000, logger), fixtureProfile());
  const session = new PresenterSession(adapter, logger, true);
  await assert.rejects(session.control({ type: "next" }), /HTTP 500/);
  assert.equal(fixture.state.triggerCount, 1);
  assert.equal((await session.refresh()).currentSlide?.id, "s1");
});

test("a trigger with a lost response is not retried; the next observation resynchronizes", async t => {
  const fixture = await presenterFixture();
  t.after(() => fixture.close());
  fixture.state.dropTriggerResponse = true;
  const logger = new MemoryLogger();
  const adapter = new HttpProPresenterAdapter(new HttpClient(fixture.baseUrl, 1000, logger), fixtureProfile());
  const session = new PresenterSession(adapter, logger, true);
  await assert.rejects(session.control({ type: "next" }), /fetch failed/);
  assert.equal(fixture.state.triggerCount, 1);
  assert.equal((await session.refresh()).currentSlide?.id, "s2");
  assert.ok(logger.events.some(item => item.event === "control_failed" && item.data.outcome === "unknown; never retried"));
});

test("HTTP requests time out, reject redirects and keep credentials off other origins", async t => {
  let leaked = false;
  const other = await serve((_request, response) => { leaked = true; response.end("unexpected"); });
  t.after(() => other.close());
  const server = await serve((request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { Location: other.baseUrl }).end(); return; }
    // /slow intentionally sends no response.
  });
  t.after(() => server.close());
  const logger = new MemoryLogger();
  const client = new HttpClient(server.baseUrl, 50, logger, "test-secret");
  await assert.rejects(client.request("GET", "/slow"), /timeout|aborted/i);
  await assert.rejects(client.request("GET", "/redirect"), /HTTP 302/);
  await assert.rejects(client.request("GET", "//example.com"), /single/);
  assert.equal(leaked, false);
  assert.equal(JSON.stringify(logger.events).includes("test-secret"), false);
});

test("HTTP response size is bounded", async t => {
  const server = await serve((_request, response) => { response.end("x".repeat(1_048_577)); });
  t.after(() => server.close());
  const client = new HttpClient(server.baseUrl, 1000, new MemoryLogger());
  await assert.rejects(client.request("GET", "/large"), /exceeds 1 MiB/);
});
