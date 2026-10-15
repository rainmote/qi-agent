import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aggregate, main, sourceManifest } from "../report-telemetry.mjs";

const options = { from: "2026-10-14T00:00:00+08:00", to: "2026-10-15T00:00:00+08:00", timezone: "Asia/Singapore" };
const event = (id, type, data = {}, at = "2026-10-14T01:00:00+08:00") => ({ id, type, data, at });
const summarize = events => aggregate([{ file: "fixture.jsonl", events }], { ...options, sample: "fixture" }).groups.fixture;

test("resumed provenance never relabels older events across midnight", () => {
  const sessions = [{ file: 'legacy.jsonl', events: [
    event('old-session', 'session/start', { session_id: 's' }, '2026-10-13T23:59:00+08:00'),
    event('old', 'agent/run/start', { 'run-id': 'old' }, '2026-10-13T23:59:59+08:00'),
    event('old-end', 'agent/run/end', { 'run-id': 'old', status: 'completed' }, options.from),
    event('source', 'session/source', { session_id: 's', sample_kind: 'fixture', profile_sha256: 'a'.repeat(64), source_sha: null }),
    event('new', 'agent/run/start', { 'run-id': 'new' }),
    event('new-end', 'agent/run/end', { 'run-id': 'new', status: 'failed' }),
    event('next-day', 'agent/run/start', { 'run-id': 'future' }, options.to),
  ] }];
  const report = aggregate(sessions, options);
  assert.equal(report.groups.unclassified.terminal, 1);
  assert.equal(report.groups.unclassified.orphan_terminal, 0);
  assert.equal(report.groups.fixture.admitted, 1);
  assert.equal(report.groups.fixture.terminal, 1);
  assert.equal(report.groups.production.sample_count.admitted_runs, 0);
  assert.equal(report.groups.production.failure_rate, null);
});

test("source manifests export metadata and distinguish missing, empty and unclassified", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qi-source-manifest-'));
  const args = ['--from', options.from, '--to', options.to, '--timezone', options.timezone, '--session-root', directory];
  try {
    assert.equal(main(args).source_status, 'no_events');
    const source = path.join(directory, 's.jsonl');
    const events = [event('start', 'session/start', { session_id: 's' }),
      event('body', 'message', { message: { content: 'PRIVATE-MESSAGE-SENTINEL' }, api_key: 'PRIVATE-KEY-SENTINEL' })];
    fs.writeFileSync(source, events.map(row => JSON.stringify(row)).join('\n'));
    const report = main(args);
    assert.equal(report.source_status, 'unclassified');
    assert.equal(report.sources[0].window_events, 2);
    assert.equal(report.sources[0].source_records[0].source_sha, null);
    assert.ok(!JSON.stringify(report).includes('PRIVATE-'));
    assert.equal(main([...args, '--session-root', path.join(directory, 'missing')]).source_status, 'missing_source');
    assert.equal(sourceManifest([{ file: source, events: [] }], options)[0].first_at, null);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test("session start alone gives no_samples and null rates, never production health", () => {
  const events = [event("session", "session/start", { session_id: "s" })];
  const report = aggregate([{ file: "s.jsonl", events }], options);
  assert.equal(report.groups.unclassified.status, "no_samples");
  assert.equal(report.groups.production.admitted, 0);
  assert.equal(report.groups.production.failure_rate, null);
  assert.equal(report.groups.unclassified.request_usage.total_cost_usd, null);
});

test("logical requests deduplicate lifecycle events and retain unknown failed usage", () => {
  const records = [event("s", "agent/run/start", { "run-id": "r" }),
    ...Array.from({ length: 7 }, (_, index) => [
      event(`start-${index}`, "usage/request", { request_id: `q${index}`, "run-id": "r", purpose: index ? "compaction" : "main", status: "started" }),
      event(`end-${index}`, "usage/request", { request_id: `q${index}`, "run-id": "r", purpose: index ? "compaction" : "main", status: "completed", usage: { input_tokens: 10, output_tokens: 2 } }),
    ]).flat(),
    event("e", "agent/run/end", { "run-id": "r", status: "completed" })];
  let result = summarize([...records, ...records]);
  assert.equal(result.logical_requests, 7);
  assert.equal(result.request_usage.known_input_tokens, 70);
  assert.equal(result.requests_by_purpose.compaction, 6);
  assert.equal(result.terminal_coverage, 1);
  assert.equal(result.request_usage.accounting_complete, false);
  result = summarize([...records, event("unknown", "usage/request", { request_id: "failed", status: "failed", purpose: "main", attempt: 1 })]);
  assert.equal(result.request_usage.unknown_requests, 1);
  assert.equal(result.request_usage.known_input_tokens, 70);
  assert.equal(result.retry_requests, 1);
  assert.equal(result.missing_run_ids, 1);
});

test("window boundaries, orphans, legacy data and traffic groups remain explicit", () => {
  const result = aggregate([{ file: "s", events: [
    event("session", "session/start", { session_id: "s", sample_kind: "ci" }),
    event("before", "agent/run/start", { "run-id": "old" }, "2026-10-13T23:59:59+08:00"),
    event("old-end", "agent/run/end", { "run-id": "old", status: "completed" }),
    event("orphan", "agent/run/end", { "run-id": "orphan", status: "uncertain" }),
    event("admitted", "agent/run/start", { "run-id": "waiting" }, options.from),
    event("future", "agent/run/end", { "run-id": "waiting", status: "completed" }, options.to),
    event("legacy", "agent/error", {}),
  ] }], options);
  assert.equal(result.groups.ci.admitted, 1);
  assert.equal(result.groups.ci.terminal, 2);
  assert.equal(result.groups.ci.orphan_terminal, 1);
  assert.equal(result.groups.ci.unfinished_admitted, 1);
  assert.equal(result.groups.ci.terminal_coverage, 0);
  assert.equal(result.groups.ci.legacy_errors, 1);
  assert.equal(result.groups.production.status, "no_samples");
});

test("compaction and queue receipts count identities rather than raw events", () => {
  const result = summarize([
    event("c-start", "context/compaction", { "compaction-id": "c", status: "started" }),
    event("c-progress", "context/compaction", { "compaction-id": "c", status: "progress" }),
    event("c-end", "context/compaction", { "compaction-id": "c", status: "failed" }),
    event("q1", "queue/added", { id: "q" }), event("q2", "queue/consumed", { id: "q" }),
    event("q3", "queue/consumed", { id: "q" }),
  ]);
  assert.equal(result.compactions.attempts, 1);
  assert.equal(result.compactions.failed, 1);
  assert.deepEqual(result.queue, { added: 1, consumed: 1, discarded: 0 });
});

test("CLI is read-only and reports corrupt logs, missing paths and invalid timestamps", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "qi-telemetry-"));
  try {
    const source = path.join(directory, "s.jsonl");
    const bytes = [JSON.stringify(event("ok", "session/start", { session_id: "s" })), "{truncated", JSON.stringify(event("bad", "message", {}, "bad date")), "null"].join("\n");
    fs.writeFileSync(source, bytes);
    const args = ["--from", options.from, "--to", options.to, "--timezone", options.timezone, "--session-root", directory, "--session-root", path.join(directory, "missing")];
    const result = main(args);
    assert.equal(result.status, "incomplete");
    assert.equal(result.parse_errors.length, 2);
    assert.equal(result.invalid_timestamps, 1);
    assert.equal(result.missing_sources.length, 1);
    assert.equal(result.groups.unclassified.failure_rate, null);
    assert.equal(fs.readFileSync(source, "utf8"), bytes);
    assert.deepEqual(fs.readdirSync(directory), ["s.jsonl"]);
    assert.throws(() => main(args.map(value => value === options.from ? "2026-10-14T00:00:00" : value)), /timestamps with offsets/);
    assert.throws(() => main(args.map(value => value === options.timezone ? "Invalid/Timezone" : value)), /time zone/i);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
