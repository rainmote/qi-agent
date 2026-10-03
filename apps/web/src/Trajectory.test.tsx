import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTrajectoryRecords, Trajectory } from "./Trajectory";
import type { DurableEvent } from "./types";

function event(seq: number, type: string, data: Record<string, unknown> = {}): DurableEvent {
  return { id: `event-${seq}`, seq, type, data, at: `2026-08-28T00:00:${String(seq).padStart(2, "0")}Z` };
}

const events = [
  event(1, "session/start", { session_id: "session-1" }),
  event(2, "message", { message: { role: "user", content: "介绍本项目" } }),
  event(3, "step/start", { step: 1 }),
  event(4, "context/snapshot", { step: 1, content: "Current runtime context for /workspace/qi-agent" }),
  event(5, "message", { message: { role: "assistant", content: "我先读取 README。" } }),
  event(6, "tool/call", { "call-id": "call-1", name: "read", arguments: { path: "README.md" } }),
  event(7, "tool/result", { "call-id": "call-1", name: "read", ok: true, content: "# qì agent", "duration-ms": 125 }),
  event(8, "message", { message: { role: "tool", tool_call_id: "call-1", content: "# qì agent" } }),
  event(9, "message", { message: { role: "assistant", content: null, tool_calls: [{ id: "call-2" }, { id: "call-3" }] } }),
  event(10, "step/end", { step: 1 }),
];

test("projects durable events into a turn-aware semantic ledger", () => {
  const records = buildTrajectoryRecords(events);

  assert.deepEqual(records.map((record) => record.label), ["SYSTEM", "USER", "CONTEXT", "ASSISTANT", "TOOL", "ASSISTANT"]);
  assert.equal(records[1].turn, 1);
  assert.equal(records[2].request, 1);
  assert.match(records[2].text, /Current runtime context/);
  assert.equal(records[3].request, 1);
  assert.match(records[4].text, /^read /);
  assert.match(records[4].text, /→ # qì agent/);
  assert.equal(records[4].durationMs, 125);
  assert.equal(records[5].text, "Preparing to call 2 tools");
});

test("renders the DeepSeek-style trajectory controls and three-lane overview", () => {
  const markup = renderToStaticMarkup(<Trajectory events={events} />);

  assert.match(markup, /aria-label="轨迹工具栏"/);
  assert.match(markup, />Duration</);
  assert.match(markup, />Turns</);
  assert.match(markup, />Calls</);
  assert.match(markup, /Timeline overview; drag horizontally to focus events/);
  assert.match(markup, /lane-input/);
  assert.match(markup, /lane-model/);
  assert.match(markup, /lane-tools/);
});

test("long trajectories mount a bounded window and bounded overview", () => {
  const long = Array.from({ length: 8000 }, (_, index) => ({
    id: `long-${index}`, seq: index, at: "2026-10-02T00:00:00Z", type: "message",
    data: { message: { role: index % 2 ? "assistant" : "user", content: `row ${index}` } },
  }));
  const html = renderToStaticMarkup(<Trajectory events={long} />);
  assert.ok((html.match(/class="trajectory-record /g) || []).length < 50);
  assert.ok((html.match(/class="trajectory-span /g) || []).length <= 360);
  assert.match(html, /aria-rowcount="8000"/);
});

test("trajectory detail serialization is deferred and cached until requested", () => {
  let serialized = 0;
  const detail = { toJSON: () => { serialized++; return { large: "detail" }; } };
  const records = buildTrajectoryRecords([{ id: "lazy", seq: 1, at: "", type: "message",
    data: { message: { role: "user", content: "visible" }, extra: detail } }]);
  assert.equal(serialized, 0);
  assert.match(records[0].detail(), /large/);
  records[0].detail();
  assert.equal(serialized, 1);
});

test("screenshot payloads stay out of trajectory text and searchable JSON details", () => {
  const records = buildTrajectoryRecords([
    event(1, "tool/call", { "call-id": "screen", name: "computer", arguments: { action: "screenshot" } }),
    event(2, "tool/result", { "call-id": "screen", content: "Screenshot captured", ok: true,
      images: [{ type: "image", url: "data:image/png;base64,c2Vuc2l0aXZlLWltYWdlLWRhdGE=", detail: "auto" }] }),
  ]);
  assert.equal(records.length, 1);
  assert.match(records[0].text, /Screenshot captured/);
  assert.match(records[0].detail(), /图片数据已省略/);
  assert.doesNotMatch(records[0].detail(), /c2Vuc2l0aXZl/);
  assert.match(records[0].detail(), /"ok": true/);
});
