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

test("queued content survives cancellation and snapshot replay in all transcript views", () => {
  const message = [{ type: "text", text: "Keep this follow-up" }, { type: "attachment", id: "queue-file-001",
    workspaceId: "0123456789abcdef", name: "notes.txt", mime: "text/plain", size: 12 }];
  for (const view of ["compact", "standard", "detailed", "verbose"] as const) {
    const snapshot = fixtureSnapshot(0);
    snapshot.events = [event("q1", "queue/added", { id: "queued-a", kind: "follow-up", message })];
    const render = () => renderToStaticMarkup(<Timeline projection={fromSnapshot(snapshot)} scrollRef={createRef()} view={view} />);
    assert.match(render(), /等待发送/);
    snapshot.events.push(event("q2", "queue/discarded", { id: "queued-a", kind: "follow-up", message, reason: "aborted" }));
    const html = render();
    assert.match(html, /未发送 · 运行已取消/);
    assert.equal(html.split("Keep this follow-up").length - 1, 1);
    assert.match(html, /attachments\/queue-file-001\?download=1/);
    assert.match(html, /aria-label="复制"/);
    assert.doesNotMatch(html, /等待发送/);
  }
});

test("interrupted queue delivery is unconfirmed while the next run still waits", () => {
  const snapshot = fixtureSnapshot(0);
  snapshot.events = [
    event("r1", "agent/run/start", { "run-id": "old" }),
    event("r2", "queue/added", { id: "a", message: "Interrupted follow-up" }),
    event("r3", "message", { message: { role: "user", content: "Interrupted follow-up" } }),
    event("r4", "agent/run/end", { "run-id": "old", status: "uncertain", reason: "restored" }),
    event("r5", "agent/run/start", { "run-id": "new" }),
    event("r6", "queue/added", { id: "b", message: "New follow-up" }),
    event("r7", "agent/run/end", { "run-id": "old", status: "uncertain", host_arbitrated: true }),
  ];
  const projection = fromSnapshot(snapshot);
  const html = renderToStaticMarkup(<Timeline projection={projection} scrollRef={createRef()} />);
  assert.match(html, /发送状态未确认/);
  assert.match(html, /等待发送/);
  assert.doesNotMatch(html, /未发送/);
  assert.equal(projection.timeline.rows.filter(row => row.kind === "message").length, 1);
  assert.deepEqual(projection.events, snapshot.events);
});

test("admission before the run envelope still reconciles interrupted delivery", () => {
  const snapshot = fixtureSnapshot(0);
  snapshot.events = [
    event("early1", "queue/added", { id: "early", message: "Early follow-up" }),
    event("early2", "agent/run/start", { "run-id": "run" }),
    event("early3", "agent/run/end", { "run-id": "run", status: "uncertain", reason: "restored" }),
  ];
  const html = renderToStaticMarkup(<Timeline projection={fromSnapshot(snapshot)} scrollRef={createRef()} />);
  assert.match(html, /Early follow-up/);
  assert.match(html, /发送状态未确认/);
  assert.doesNotMatch(html, /等待发送|未发送/);
});

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

test("reasoning-only assistant messages remain readable instead of disappearing", () => {
  const snapshot = fixtureSnapshot(0);
  snapshot.events = [event("reason1", "message", { message: {
    role: "assistant", content: null, reasoning_content: "先核对文件，再决定下一步。",
  } })];
  const projection = fromSnapshot(snapshot);
  assert.equal(projection.timeline.rows.length, 1, "persisted reasoning must reach the conversation");
  const html = renderToStaticMarkup(<Timeline projection={projection} scrollRef={createRef<HTMLDivElement>()} />);
  assert.match(html, /先核对文件，再决定下一步/);
});
