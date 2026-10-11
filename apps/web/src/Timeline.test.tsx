import assert from "node:assert/strict";
import test from "node:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fromSnapshot } from "./projection";
import { fixtureSnapshot } from "./timeline-fixture-data";
import { buildToolBatches, operationTarget, toolBatchStatus, Timeline } from "./Timeline";
import type { DurableEvent } from "./types";

function event(id: string, type: string, data: Record<string, unknown> = {}): DurableEvent {
  return { id, type, data, seq: Number(id.replace(/\D/g, "")) || 1, at: "2026-08-19T00:00:00Z" };
}

test("groups all tool calls from the same runtime step", () => {
  const events = [
    event("step1", "step/start", { step: 1 }),
    event("call1", "tool/call", { name: "read", "call-id": "a", arguments: { path: "README.md" } }),
    event("approval1", "approval/decision", { decision: "allow" }),
    event("call2", "tool/call", { name: "grep", "call-id": "b", arguments: { query: "TODO" } }),
    event("result1", "tool/result", { "call-id": "a", ok: true }),
    event("result2", "tool/result", { "call-id": "b", ok: true }),
    event("stepend1", "step/end", { step: 1 }),
    event("step2", "step/start", { step: 2 }),
    event("call3", "tool/call", { name: "bash", "call-id": "c", arguments: { command: "npm test" } }),
    event("stepend2", "step/end", { step: 2 }),
  ];
  const grouped = buildToolBatches(events);

  assert.deepEqual(grouped.batches.get("call1")?.calls.map(({ id }) => id), ["call1", "call2"]);
  assert.equal(grouped.groupedCallIds.has("call2"), true);
  assert.deepEqual(grouped.batches.get("call3")?.calls.map(({ id }) => id), ["call3"]);
});

test("describes and truncates tool operation targets", () => {
  const bash = event("call1", "tool/call", {
    name: "bash",
    arguments: { cwd: "apps/web", command: "npm run a-very-long-command-name" },
  });
  const grep = event("call2", "tool/call", {
    name: "grep",
    arguments: { path: "src", query: "tool_calls" },
  });

  assert.equal(operationTarget(grep), "src · tool_calls");
  assert.equal(operationTarget(bash, 20), "apps/web · npm run …");
});


test("long histories mount a bounded window rather than every Markdown message", () => {
  const projection = fromSnapshot(fixtureSnapshot(2_000));
  const html = renderToStaticMarkup(<Timeline projection={projection} scrollRef={createRef<HTMLDivElement>()} />);
  assert.match(html, /data-total-rows="6000"/);
  const mounted = (html.match(/class="timeline-row"/g) || []).length;
  assert.ok(mounted > 0 && mounted < 30, `mounted ${mounted} rows`);
  assert.ok(html.length < 100_000);
  assert.match(html, /回复 2000/);
});

test("completed tool groups are summarized while failures and unconfirmed results remain visible", () => {
  const snapshot = fixtureSnapshot(1);
  const render = () => renderToStaticMarkup(<Timeline projection={fromSnapshot(snapshot)} scrollRef={createRef<HTMLDivElement>()} />);
  const completed = render();
  assert.match(completed, /读取 ×1 · 搜索 ×1/);
  assert.match(completed, /2 项完成/);
  assert.doesNotMatch(completed, /tool-batch-row|tool-details|多行工具结果/);
  const result = snapshot.events.find(event => event.type === "tool/result")!;
  result.data = { ...result.data, ok: false, error: "Permission denied" };
  assert.match(render(), /1 失败/);
  assert.match(render(), /Permission denied/);
  snapshot.events = snapshot.events.filter(event => event.type !== "tool/result");
  assert.match(render(), /2 项结果未确认/);
  assert.doesNotMatch(render(), /is-running|项完成/);
});

test("a stopped call with no result is unconfirmed, and only an active group may be running", () => {
  const batch = { id: "step", calls: [event("call1", "tool/call", { name: "bash", "call-id": "a" })] };
  assert.deepEqual(toolBatchStatus(batch, new Map(), false), { completed: 0, failed: 0, missing: 1, running: false });
  assert.equal(toolBatchStatus(batch, new Map(), true).running, true);
  assert.equal(toolBatchStatus(batch, new Map([["a", event("result1", "tool/result", { ok: false })]]), true).running, false);
});
