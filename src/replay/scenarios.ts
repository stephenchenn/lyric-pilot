import type { Song } from "../song/model.ts";
import type { FollowerEvent } from "../transcription/types.ts";
import type { ReplayScenario } from "./replay.ts";

export function makeScenario(song: Song, name: string, slideIds: string[], options: { noisy?: boolean; dropoutAfter?: number } = {}): ReplayScenario {
  const events: FollowerEvent[] = [];
  const groundTruth: ReplayScenario["groundTruth"] = [];
  let atMs = 0;
  for (const [index, slideId] of slideIds.entries()) {
    const slide = song.slides.find(slide => slide.id === slideId);
    if (!slide) throw new Error(`Unknown scenario slide ${slideId}`);
    groundTruth.push({ atMs, slideId });
    let text = slide.text;
    if (options.noisy) text = text.replace(/voices/i, "voics").replace(/through/i, "thru").replace(/uncertain/i, "uncertan").replace(/safely/i, "safley");
    events.push({ type: "transcript", id: `${name}-${index}`, startMs: atMs, endMs: atMs + 700, atMs: atMs + 700, text: text.split(/\s+/).slice(0, 4).join(" "), final: false });
    events.push({ type: "transcript", id: `${name}-${index}`, startMs: atMs, endMs: atMs + 1450, atMs: atMs + 1450, text, final: true });
    atMs += 4500;
    events.push({ type: "tick", atMs: atMs - 200 });
    if (index === options.dropoutAfter) {
      atMs += 6000;
      events.push({ type: "tick", atMs: atMs - 3000 }, { type: "tick", atMs: atMs - 100 });
    }
  }
  return { name, description: "Synthetic transcript fixture; no measured singing recognition. Ground truth never enters the matcher.", durationMs: atMs, events, groundTruth };
}

export function syntheticScenarios(song: Song): ReplayScenario[] {
  const normal = ["s1", "s2", "s3", "s4", "s5", "s6", "s3", "s4", "s7", "s8", "s3", "s4"];
  const manual = makeScenario(song, "manual-correction", ["s1", "s5", "s6", "s3", "s4"]);
  manual.events.push({ type: "manual", atMs: 4600, slideId: "s5", stepIndex: 2 });
  // A conflicting phrase during the grace period must not undo the human.
  manual.events.push({ type: "transcript", id: "manual-conflict", startMs: 4700, endMs: 6000, atMs: 6000, text: "We lift our voices together", final: true });
  manual.events.sort((a, b) => a.atMs - b.atMs);
  return [
    makeScenario(song, "normal", normal),
    makeScenario(song, "extra-chorus", [...normal.slice(0, 8), "s3", "s4", ...normal.slice(8)]),
    makeScenario(song, "skip-chorus", [...normal.slice(0, 6), ...normal.slice(8)]),
    makeScenario(song, "jump-bridge", ["s1", "s2", "s7", "s8", "s3", "s4"]),
    makeScenario(song, "return-verse", [...normal.slice(0, 10), "s5", "s6", "s3", "s4"]),
    makeScenario(song, "noisy-transcript", normal, { noisy: true }),
    makeScenario(song, "vocal-dropout", normal, { dropoutAfter: 3 }),
    manual,
  ];
}
