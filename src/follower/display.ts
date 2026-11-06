import type { FollowerFrame } from "./engine.ts";
import type { Song } from "../song/model.ts";
import type { ReplayMetrics } from "../replay/replay.ts";

export const percentage = (value: number) => `${(value * 100).toFixed(1)}%`;
export const clock = (ms: number) => `${Math.floor(ms / 60_000).toString().padStart(2, "0")}:${(ms % 60_000 / 1000).toFixed(2).padStart(5, "0")}`;
export function formatFrame(frame: FollowerFrame, song: Song, options: { diagnostics?: boolean; color?: boolean } = {}): string {
  const lyric = song.slides.find(slide => slide.id === frame.displayedSlideId)!;
  const style = (text: string, code: string) => options.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  let wordIndex = 0;
  const displayedText = frame.progress && frame.tracked.slideId === frame.displayedSlideId && options.color ? lyric.text.replace(/[A-Za-z]+(?:['’][A-Za-z]+)?/g, word => {
    const status = frame.progress!.words[wordIndex++]?.status;
    return style(word, status === "heard" ? "1;92" : status === "uncertain" ? "33" : "2");
  }) : style(lyric.text, "1;92");
  const lines = [
    `\n${style(`${clock(frame.atMs)}  ${frame.mode} · SIMULATED OUTPUT`, "2")}${frame.paused ? " · PAUSED" : ""}${frame.healthy ? "" : " · INPUT UNAVAILABLE"}`,
    style(`TRANSCRIPT  ${frame.transcript || "(waiting for lyrics)"}`, "1;96"),
    `${style(`DISPLAYED   [${lyric.id}] `, "1;92")}${displayedText}`,
    ...(frame.progress ? [`FOLLOWING   ${frame.progress.heardWords}/${frame.progress.totalWords} words supported · next: ${frame.progress.nextWord ?? "end"}${frame.tracked.slideId !== frame.displayedSlideId ? ` · tracking ${frame.tracked.slideId}` : ""}`] : []),
  ];
  if (!options.diagnostics) {
    if (!frame.healthy) lines.push(`Input: ${frame.inputMessage}`);
    return lines.join("\n");
  }
  const section = song.sections.find(section => section.id === frame.tracked.sectionId)!;
  const evidence = frame.progress ? [
    "Word                 status     acoustic support",
    ...frame.progress.words.map(word => `${word.text.padEnd(20)} ${word.status.padEnd(10)} ${word.confidence === null ? "—" : word.confidence.toFixed(2)}`),
  ] : [
    "Candidate     text   plan  near  hist  score  words",
    ...frame.candidates.slice(0, 3).map(candidate => `${candidate.slideId.padEnd(12)} ${candidate.audio.toFixed(2)}   ${candidate.structure.toFixed(2)}  ${candidate.proximity.toFixed(2)}  ${candidate.history.toFixed(2)}  ${candidate.score.toFixed(2)}   ${candidate.matchedWords}`),
    ...(frame.candidates[0]?.phrase ? [`Best phrase: ${frame.candidates[0].phrase} | Exact content: ${frame.candidates[0].exactContentWords.join(", ") || "none"}`] : []),
  ];
  return [...lines,
    `Tracking ${frame.tracked.slideId} · ${section.label} #${frame.tracked.occurrence ?? "unplanned"}${frame.tracked.extraRepeat ? ` +${frame.tracked.extraRepeat} extra repeat` : ""}${frame.deviation ? " · DEVIATION" : ""} | Expected ${frame.expected?.slideId ?? "end/unplanned"}`,
    `Input: ${frame.inputMessage}`,
    ...evidence,
    `${frame.decision.action.toUpperCase()}: ${frame.decision.reason}${frame.progress ? "" : ` | margin ${frame.decision.margin.toFixed(2)} | stable ${frame.decision.stableForMs}ms / ${frame.decision.stableUpdates} updates`}`,
    `Last action: ${frame.lastAction}`,
  ].join("\n");
}

export function formatMetrics(metrics: ReplayMetrics | null): string {
  if (!metrics) return "No ground truth provided; accuracy and transition latency are unmeasured.";
  return [
    metrics.top1Accuracy === null || metrics.top3Accuracy === null ? "Planned acoustic word tracking; slide ranking is not used." : `Top-1 ${percentage(metrics.top1Accuracy)} · Top-3 ${percentage(metrics.top3Accuracy)} (${metrics.transcriptSamples} transcript updates)`,
    `Correct tracking time ${percentage(metrics.trackingTimeAccuracy)} · Correct displayed time ${percentage(metrics.displayedTimeAccuracy)}`,
    `Transitions ${metrics.matchedTransitions}/${metrics.expectedTransitions} · Missed ${metrics.missedTransitions} · False ${metrics.falseTransitions}`,
    `Transition latency median ${metrics.medianLatencyMs === null ? "n/a" : `${metrics.medianLatencyMs}ms`} · p95 ${metrics.p95LatencyMs === null ? "n/a" : `${metrics.p95LatencyMs}ms`}`,
  ].join("\n");
}
