import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { MockProPresenterAdapter } from "../src/propresenter/mock.ts";
import { PresenterSession } from "../src/propresenter/session.ts";
import { MemoryLogger } from "./helpers.ts";

function setup() {
  const logger = new MemoryLogger();
  const adapter = new MockProPresenterAdapter(logger);
  const session = new PresenterSession(adapter, logger);
  return { logger, adapter, session };
}

test("synthetic song supports controlled transitions, direct selection and boundaries", async () => {
  const { session, logger } = setup();
  assert.equal((await session.connect()).currentSlide?.id, "s1");
  const slides = await session.listSlides();
  assert.equal(slides.length, 8);
  assert.equal(slides[0]?.index, 0);
  await assert.rejects(session.control({ type: "previous" }), /boundary crossing/);
  const next = await session.control({ type: "next" });
  assert.equal(next.confirmed, true);
  assert.equal(next.snapshot.currentSlide?.id, "s2");
  assert.equal((await session.control({ type: "previous" })).target.id, "s1");
  await session.control({ type: "goto", slideId: "s8" });
  await assert.rejects(session.control({ type: "next" }), /boundary crossing/);
  await assert.rejects(session.control({ type: "goto", slideId: "unknown" }), /No target/);
  await assert.rejects(session.control({ type: "goto", slideId: "s8" }), /already current/);
  assert.equal(logger.events.filter(item => item.event === "mock_trigger").length, 3);
});

test("manual slide changes are observed and become the new navigation anchor", async () => {
  const { session, adapter, logger } = setup();
  await session.connect();
  adapter.manualSelect("s7");
  assert.equal((await session.refresh()).currentSlide?.id, "s7");
  assert.equal((await session.control({ type: "next" })).target.id, "s8");
  assert.ok(logger.events.some(item => item.event === "slide_changed" && item.data.attribution === "external-or-manual"));
});

test("disconnect fails passively, clears stale state and recovers without a trigger", async () => {
  const { session, adapter, logger } = setup();
  await session.connect();
  adapter.setConnected(false);
  const offline = await session.refresh();
  assert.equal(offline.health.status, "disconnected");
  assert.equal(offline.currentSlide, null);
  await assert.rejects(session.control({ type: "next" }), /Control blocked/);
  adapter.manualSelect("s5");
  adapter.setConnected(true);
  const recovered = await session.refresh();
  assert.equal(recovered.currentSlide?.id, "s5");
  assert.equal(logger.events.filter(item => item.event === "mock_trigger").length, 0);
});

test("control yields if a human changes state while the slide catalog loads", async () => {
  const { session, adapter, logger } = setup();
  await session.connect();
  const original = adapter.getSlides.bind(adapter);
  adapter.getSlides = async id => {
    const slides = await original(id);
    adapter.manualSelect("s7");
    return slides;
  };
  await assert.rejects(session.control({ type: "next" }), /state changed during preparation/);
  assert.equal((await session.refresh()).currentSlide?.id, "s7");
  assert.equal(logger.events.filter(item => item.event === "mock_trigger").length, 0);
});

test("polling observes an external selection without any controls", async () => {
  const { session, adapter, logger } = setup();
  await session.connect();
  const changed = new Promise<string>(resolve => {
    session.onSnapshot(snapshot => {
      if (snapshot.currentSlide?.id === "s4") resolve(snapshot.currentSlide.id);
    });
  });
  const stop = session.startPolling(10);
  try {
    adapter.manualSelect("s4");
    assert.equal(await Promise.race([changed, delay(1000).then(() => "timeout")]), "s4");
    assert.equal(logger.events.filter(item => item.event === "mock_trigger").length, 0);
  } finally { stop(); }
});

test("a failed command does not poison subsequent observations or commands", async () => {
  const { session } = setup();
  await assert.rejects(session.control({ type: "goto", slideId: "bad" }));
  assert.equal((await session.refresh()).health.status, "connected");
  assert.equal((await session.control({ type: "next" })).confirmed, true);
});
