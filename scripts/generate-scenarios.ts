import { mkdirSync, writeFileSync } from "node:fs";
import { loadSong } from "../src/song/model.ts";
import { syntheticScenarios } from "../src/replay/scenarios.ts";

mkdirSync("data/replays", { recursive: true });
for (const scenario of syntheticScenarios(loadSong())) {
  writeFileSync(`data/replays/${scenario.name}.json`, JSON.stringify(scenario, null, 2) + "\n");
}
console.log("Saved eight deterministic transcript scenarios to data/replays/");
