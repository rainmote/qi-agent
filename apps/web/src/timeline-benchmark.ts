// Run: node --import tsx apps/web/src/timeline-benchmark.ts
// Pure synthetic data; timings cover projection CPU only, not browser rendering or transport.
import { performance } from "node:perf_hooks";
import { applyHostEvent, fromSnapshot } from "./projection";
import { fixtureSnapshot } from "./timeline-fixture-data";
import type { DurableEvent, HostEvent } from "./types";

const snapshot = fixtureSnapshot(4_000);
const samples = 5;
const iterations = 100;
const appended: DurableEvent[] = Array.from({ length: iterations }, (_, index) => ({
  id: `benchmark-${index}`, seq: snapshot.events.length + index + 1, at: "2026-10-02T00:00:00Z",
  type: "message", data: { message: { role: "assistant", content: `Sample ${index}` } },
}));
const envelopes: HostEvent[] = appended.map((event) => ({ hostSeq: event.seq, type: "event", version: 1,
  durable: true, event_id: event.id, seq: event.seq, at: event.at, event: event.type, data: event.data }));
function median(values: number[]): number { return Number(values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(3)); }
function benchmark(run: () => void): number {
  run();
  return median(Array.from({ length: samples }, () => {
    const start = performance.now(); run(); return performance.now() - start;
  }));
}
const base = fromSnapshot(snapshot);
const legacyAppend = benchmark(() => {
  let events = base.events;
  for (const event of appended) {
    if (!events.some((existing) => existing.id === event.id)) events = [...events, event].sort((a, b) => a.seq - b.seq);
  }
});
const indexedAppend = benchmark(() => {
  let projection = base;
  for (const event of envelopes) projection = applyHostEvent(projection, event);
});
const replay = snapshot.events.slice(-iterations).map((event): HostEvent => ({ hostSeq: event.seq, type: "event", version: 1,
  durable: true, event_id: event.id, seq: event.seq, event: event.type, data: event.data }));
const legacyReplay = benchmark(() => { for (const event of replay) base.events.some((existing) => existing.id === event.event_id); });
const indexedReplay = benchmark(() => { for (const event of replay) applyHostEvent(base, event); });
console.log(JSON.stringify({ events: snapshot.events.length, rows: base.timeline.rows.length, samples, iterations,
  medianMs: { legacyAppend, indexedAppend, legacyReplay, indexedReplay },
  scope: "Projection CPU only. Indexed append also updates timeline and summary; legacy excludes those old full scans. Immutable event arrays still copy on append; late insertion rebuilds timeline." }, null, 2));
