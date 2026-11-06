import type { ReplayReport } from "./replay.ts";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const palette = ["#3b82f6", "#8b5cf6", "#10b981", "#eab308", "#f97316", "#ec4899", "#06b6d4", "#6366f1"];

/** Standalone vector report: availability-time output, never retroactive audio alignment. */
export function renderTimeline(report: ReplayReport): string {
  const duration = Math.max(1, report.durationMs);
  const slideIds = [...new Set([report.initialSlideId, ...report.groundTruth.map(point => point.slideId), ...report.transitions.map(point => point.slideId)])];
  const color = (id: string) => palette[slideIds.indexOf(id) % palette.length]!;
  const x = (at: number) => 175 + Math.min(duration, Math.max(0, at)) / duration * 970;
  const body: string[] = [];
  const lane = (label: string, y: number, points: { atMs: number; slideId: string }[]) => {
    body.push(`<text x="18" y="${y + 22}" fill="#cbd5e1">${label}</text>`);
    const changes = points.filter((point, index) => !index || point.slideId !== points[index - 1]!.slideId);
    for (const [index, point] of changes.entries()) {
      const end = changes[index + 1]?.atMs ?? duration;
      const width = Math.max(0, x(end) - x(point.atMs));
      body.push(`<rect x="${x(point.atMs)}" y="${y}" width="${width}" height="34" rx="3" fill="${color(point.slideId)}"><title>${escape(point.slideId)}: ${(point.atMs / 1000).toFixed(2)}–${(end / 1000).toFixed(2)}s</title></rect>`);
      if (width > 32) body.push(`<text x="${x(point.atMs) + 7}" y="${y + 22}" fill="#fff">${escape(point.slideId)}</text>`);
    }
  };
  lane("Ground truth", 72, report.groundTruth);
  lane("Tracking", 121, [{ atMs: 0, slideId: report.initialSlideId }, ...report.frames.map(frame => ({ atMs: frame.atMs, slideId: frame.tracked.slideId }))]);
  lane("Simulated output", 170, [{ atMs: 0, slideId: report.initialSlideId }, ...report.frames.map(frame => ({ atMs: frame.atMs, slideId: frame.displayedSlideId }))]);
  for (let index = 0; index <= 8; index++) {
    const at = duration * index / 8;
    body.push(`<path d="M ${x(at)} 60 V 212" stroke="#e2e8f0" opacity="0.13"/><text x="${x(at)}" y="231" text-anchor="middle" fill="#94a3b8">${(at / 1000).toFixed(1)}s</text>`);
  }
  const planned = report.frames.some(frame => frame.progress);
  const points = report.frames.filter(frame => frame.atMs <= duration).map(frame => {
    const value = frame.progress ? frame.progress.heardWords / frame.progress.totalWords : frame.candidates[0]?.score ?? 0;
    return `${x(frame.atMs)},${296 - value * 42}`;
  }).join(" ");
  body.push(`<text x="18" y="274" fill="#cbd5e1">${planned ? "Supported words" : "Candidate score"}</text><text x="18" y="292" fill="#94a3b8" font-size="11">${planned ? "fraction of current slide" : "heuristic, 0–1"}</text>`);
  body.push(`<polyline points="${points}" fill="none" stroke="#38bdf8" stroke-width="2"/><path d="M 175 296 H 1145" stroke="#475569"/>`);
  if (report.evaluationDurationMs < report.durationMs) body.push(`<path d="M ${x(report.evaluationDurationMs)} 60 V 212" stroke="#f8fafc" stroke-dasharray="4 3"/><text x="${x(report.evaluationDurationMs)}" y="247" text-anchor="end" fill="#cbd5e1">audio end</text>`);
  const summary = report.metrics ? `${report.metrics.matchedTransitions}/${report.metrics.expectedTransitions} transitions · ${report.metrics.falseTransitions} false · median delay ${report.metrics.medianLatencyMs === null ? "unmeasured" : `${report.metrics.medianLatencyMs}ms`}` : "No ground truth; accuracy unmeasured";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="345" viewBox="0 0 1200 345"><rect width="1200" height="345" fill="#0f172a"/><g font-family="system-ui,sans-serif" font-size="13"><text x="18" y="28" fill="#f8fafc" font-size="19">${escape(report.name)} · ${report.mode} simulation</text><text x="18" y="49" fill="#94a3b8">${escape(summary)}</text>${body.join("")}<text x="18" y="326" fill="#94a3b8">Time includes transcription availability and decoding delay. No real ProPresenter output.</text></g></svg>\n`;
}
