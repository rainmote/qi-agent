import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { sessionUsage } from "./session-usage";
import { ContextMeter } from "./ComposerControls";
import type { DurableEvent } from "./types";

const event = (request_id: string, data: Record<string, unknown>, type = "usage/request"): DurableEvent =>
  ({ id: `${request_id}:${data.status}`, seq: 1, at: "2026-11-14T00:00:00Z", type, data: { request_id, scope: "logical_request", ...data } });
const settled = event("one", { status: "completed", duration_ms: 1200,
  usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 800 } } });

test("session dock counts each logical request once and keeps settled facts over replayed starts", () => {
  const rows = [event("one", { status: "started" }), settled, event("one", { status: "started" }), settled,
    event("one", settled.data, "usage/child-request"), event("one", settled.data, "agent/run/end"),
    event("one", { ...settled.data, scope: "physical_request" })];
  assert.deepEqual(sessionUsage(rows), { requests: 1, input: 1000, output: 100, total: 1100, unknown: 0,
    durationMs: 1200, cached: 800, cachePercent: 80 });
});

test("incomplete failed requests cannot turn a known subtotal into a total or cache percentage", () => {
  const usage = sessionUsage([settled, event("two", { status: "failed", usage: { input_tokens: 90 } }),
    event("three", { status: "started" })]);
  assert.equal(usage.input, 1090); assert.equal(usage.total, 1190); assert.equal(usage.unknown, 2);
  assert.equal(usage.cachePercent, null); assert.equal(usage.cached, null);
});

test("failed attempts with usage and zero-token results remain real readings", () => {
  const usage = sessionUsage([event("failed", { status: "failed", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } } }),
    event("empty", { status: "completed", usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } })]);
  assert.equal(usage.total, 12); assert.equal(usage.unknown, 0); assert.equal(usage.cachePercent, 0);
  assert.equal(sessionUsage([event("bad", { status: "completed", usage: { input_tokens: -1, output_tokens: "2" } })]).unknown, 1);
  assert.equal(sessionUsage([event("bad-cache", { status: "completed", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 20 } } })]).cachePercent, null);
});

test("unavailable context is unknown even when model capacity is known; zero usage stays zero", () => {
  const unknown = renderToStaticMarkup(<ContextMeter status={null} capacity={10000} />);
  assert.match(unknown, /上下文用量未知/); assert.match(unknown, /上下文未知/); assert.doesNotMatch(unknown, /已用 0%/);
  const known = renderToStaticMarkup(<ContextMeter status={{ used_tokens: 0, context_window: 10000, percent: 0, system_tokens: 0, tool_tokens: 0, message_tokens: 0 }} />);
  assert.match(known, /上下文已用 0%/);
});
