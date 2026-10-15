#!/usr/bin/env node
// Read-only session statistics. Unlabelled records never become production samples.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const kinds = ["production", "fixture", "ci", "unclassified"];
const terminalStatuses = ["completed", "failed", "cancelled", "uncertain"];
const token = (usage, keys) => keys.map(key => usage?.[key]).find(value => Number.isSafeInteger(value) && value >= 0);
const runId = data => data?.["run-id"] ?? data?.run_id;
const sampleKind = (data, fallback) => kinds.includes(data?.sample_kind ?? data?.["sample-kind"])
  ? data.sample_kind ?? data["sample-kind"] : fallback;

export function aggregate(sessions, { from, to, timezone, sample = "unclassified" }) {
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("Invalid telemetry window");
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  if (!kinds.includes(sample)) throw new Error("Invalid sample kind");
  const groups = Object.fromEntries(kinds.map(kind => [kind, {
    admitted: new Set(), starts: new Set(), ends: new Map(), terminal: new Map(), requests: new Map(),
    compactions: new Map(), checkpoints: new Set(), queue: { added: new Set(), consumed: new Set(), discarded: new Set() },
    retryEvents: new Set(), cancelEvents: new Set(), missing_run_ids: 0, legacy_errors: 0, events: 0,
  }]));
  let invalid_timestamps = 0;
  const seen = new Set();
  for (const session of sessions) {
    const sessionStart = session.events.find(event => event.type === "session/start");
    const sessionId = sessionStart?.data?.session_id ?? session.file;
    const fallback = sampleKind(sessionStart?.data, sample);
    for (const [index, event] of session.events.entries()) {
      const instant = Date.parse(event.at);
      if (!Number.isFinite(instant)) { invalid_timestamps++; continue; }
      if (instant >= end) continue;
      const key = `${sessionId}:${event.id || `${session.file}:${index}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const data = event.data ?? {};
      const group = groups[sampleKind(data, fallback)];
      const run = runId(data);
      const runKey = run ? `${sessionId}:${run}` : null;
      const inside = instant >= start;
      if (event.type === "agent/run/start" && runKey) {
        group.starts.add(runKey);
        if (inside) group.admitted.add(runKey);
      }
      if (event.type === "agent/run/end" && runKey && terminalStatuses.includes(data.status)) {
        group.ends.set(runKey, data.status);
        if (inside) group.terminal.set(runKey, data.status);
      }
      if (!inside) continue;
      group.events++;
      if (["agent/run/start", "agent/run/end", "usage/request"].includes(event.type) && !runKey) group.missing_run_ids++;
      if (event.type === "agent/error" && !runKey) group.legacy_errors++;
      if (event.type === "usage/request") {
        const requestKey = `${sessionId}:${data.request_id || event.id || index}`;
        const previous = group.requests.get(requestKey);
        // Late started records cannot replace a terminal receipt.
        if (!previous || previous.status === "started" || data.status !== "started") group.requests.set(requestKey, data);
      }
      if (event.type === "agent/retry") group.retryEvents.add(key);
      if (event.type === "agent/aborted") group.cancelEvents.add(runKey ?? key);
      if (event.type === "context/compaction" && data["compaction-id"]) {
        const id = `${sessionId}:${data["compaction-id"]}`;
        const previous = group.compactions.get(id);
        if (!previous || !["completed", "failed", "cancelled"].includes(previous.status)) group.compactions.set(id, data);
      }
      if (event.type === "session/compaction") group.checkpoints.add(key);
      const queueKey = event.type.startsWith("queue/") ? event.type.slice(6) : "";
      const queue = Object.hasOwn(group.queue, queueKey) ? group.queue[queueKey] : null;
      if (queue) queue.add(`${sessionId}:${data.id || event.id || index}`);
    }
  }
  return {
    schema_version: 1, from, to, timezone, interval: "[from,to)", invalid_timestamps,
    groups: Object.fromEntries(Object.entries(groups).map(([kind, group]) => {
      const requests = [...group.requests.values()];
      const knownInput = requests.map(request => token(request.usage, ["input_tokens", "prompt_tokens", "input-tokens"]));
      const knownOutput = requests.map(request => token(request.usage, ["output_tokens", "completion_tokens", "output-tokens"]));
      const unknown = requests.filter((request, index) => request.status === "started" || knownInput[index] === undefined || knownOutput[index] === undefined).length;
      const statuses = Object.fromEntries(terminalStatuses.map(status => [status, [...group.terminal.values()].filter(value => value === status).length]));
      const admitted = group.admitted.size, terminal = group.terminal.size;
      return [kind, {
        status: admitted || terminal ? "samples" : "no_samples", events: group.events,
        admitted, terminal, statuses,
        orphan_terminal: [...group.terminal.keys()].filter(id => !group.starts.has(id)).length,
        unfinished_admitted: [...group.admitted].filter(id => !group.ends.has(id)).length,
        terminal_coverage: admitted ? [...group.admitted].filter(id => group.ends.has(id)).length / admitted : null,
        failure_rate: terminal ? statuses.failed / terminal : null,
        logical_requests: requests.length,
        requests_by_purpose: Object.fromEntries(["main", "compaction", "unknown"].map(purpose => [purpose,
          requests.filter(request => (["main", "compaction"].includes(request.purpose) ? request.purpose : "unknown") === purpose).length])),
        retry_requests: requests.filter(request => Number.isSafeInteger(request.attempt) && request.attempt > 0).length,
        retry_events: group.retryEvents.size, cancellation_events: group.cancelEvents.size,
        compactions: { attempts: group.compactions.size, checkpoints: group.checkpoints.size,
          ...Object.fromEntries(["completed", "failed", "cancelled"].map(status => [status,
            [...group.compactions.values()].filter(value => value.status === status).length])) },
        queue: Object.fromEntries(Object.entries(group.queue).map(([key, items]) => [key, items.size])),
        missing_run_ids: group.missing_run_ids, legacy_errors: group.legacy_errors,
        request_usage: { unknown_requests: unknown,
          known_input_tokens: knownInput.reduce((sum, value) => sum + (value ?? 0), 0),
          known_output_tokens: knownOutput.reduce((sum, value) => sum + (value ?? 0), 0),
          token_usage_complete: requests.length > 0 && unknown === 0,
          total_cost_usd: null, accounting_complete: false },
      }];
    })),
  };
}

export function readSessions(roots) {
  const result = { sessions: [], parse_errors: [], missing_sources: [], read_errors: [], skipped_symlinks: [] };
  const visited = new Set();
  function visit(file) {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      (error.code === "ENOENT" ? result.missing_sources : result.read_errors).push(file);
      return;
    }
    if (stat.isSymbolicLink()) { result.skipped_symlinks.push(file); return; }
    if (visited.has(file)) return;
    visited.add(file);
    if (stat.isDirectory()) {
      try { for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name)); }
      catch { result.read_errors.push(file); }
      return;
    }
    if (!stat.isFile() || !file.endsWith(".jsonl")) return;
    const events = [];
    try {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (!event || typeof event !== "object" || typeof event.type !== "string" ||
              !event.data || typeof event.data !== "object" || Array.isArray(event.data)) throw new Error("Invalid event");
          events.push(event);
        } catch { result.parse_errors.push({ file, line: index + 1 }); }
      }
    } catch { result.read_errors.push(file); }
    result.sessions.push({ file, events });
  }
  roots.forEach(root => visit(path.resolve(root)));
  return result;
}

export function main(argv) {
  const options = { roots: [], sample: "unclassified" };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index], value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    if (key === "--session-root") options.roots.push(value);
    else if (["--from", "--to", "--timezone"].includes(key)) options[key.slice(2)] = value;
    else if (key === "--sample-kind") options.sample = value;
    else throw new Error(`Unknown option ${key}`);
  }
  if (!options.roots.length || !options.timezone || ![options.from, options.to].every(value => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)))
    throw new Error("Required: --from/--to ISO timestamps with offsets, --timezone, --session-root (repeatable); optional --sample-kind production|fixture|ci|unclassified");
  const { sessions, ...coverage } = readSessions(options.roots);
  const report = aggregate(sessions, options);
  const incomplete = coverage.parse_errors.length || coverage.missing_sources.length || coverage.read_errors.length || coverage.skipped_symlinks.length || report.invalid_timestamps;
  return { ...report, status: incomplete ? "incomplete" : Object.values(report.groups).some(group => group.status === "samples") ? "samples" : "no_samples",
    session_files: sessions.length, ...coverage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
