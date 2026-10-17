#!/usr/bin/env node
// Read-only session statistics. Unlabelled records never become production samples.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

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
    retryEvents: new Set(), cancelEvents: new Set(), sessions: new Set(), missing_run_ids: 0, legacy_errors: 0, events: 0,
  }]));
  let invalid_timestamps = 0;
  const seen = new Set();
  for (const session of sessions) {
    const sessionStart = session.events.find(event => event.type === "session/start");
    const sessionId = sessionStart?.data?.session_id ?? session.file;
    let fallback = sample;
    for (const [index, event] of session.events.entries()) {
      const instant = Date.parse(event.at);
      if (!Number.isFinite(instant)) { invalid_timestamps++; continue; }
      if (instant >= end) continue;
      const key = `${sessionId}:${event.id || `${session.file}:${index}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const data = event.data ?? {};
      // Resume markers apply forward only. A new process must not relabel old
      // session history or borrow a previous process's source fingerprint.
      if (["session/start", "session/source"].includes(event.type)) fallback = sampleKind(data, sample);
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
      group.sessions.add(sessionId);
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
        admitted, terminal, statuses, sample_count: { sessions: group.sessions.size, admitted_runs: admitted, terminal_runs: terminal },
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

export function sourceManifest(sessions, { from, to }) {
  const start = Date.parse(from), end = Date.parse(to);
  return sessions.map(({ file, events }) => {
    const timestamps = events.map(row => Date.parse(row.at)).filter(Number.isFinite);
    const windowEvents = events.filter(row => Date.parse(row.at) >= start && Date.parse(row.at) < end);
    return { path: file, events: events.length, window_events: windowEvents.length,
      first_at: timestamps.length ? new Date(timestamps.reduce((a, b) => Math.min(a, b))).toISOString() : null,
      last_at: timestamps.length ? new Date(timestamps.reduce((a, b) => Math.max(a, b))).toISOString() : null,
      event_counts: Object.fromEntries([...new Set(windowEvents.map(row => row.type))].sort()
        .map(type => [type, windowEvents.filter(row => row.type === type).length])),
      source_records: events.filter(row => ["session/start", "session/source"].includes(row.type)).map(row => ({
        at: row.at, sample_kind: sampleKind(row.data, 'unclassified'),
        source_sha: /^[a-f0-9]{40}$/.test(row.data.source_sha) ? row.data.source_sha : null,
        profile_sha256: /^[a-f0-9]{64}$/.test(row.data.profile_sha256) ? row.data.profile_sha256 : null,
      })),
    };
  });
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
    let sha256 = null;
    try {
      const bytes = fs.readFileSync(file);
      sha256 = createHash('sha256').update(bytes).digest('hex');
      const lines = bytes.toString('utf8').split("\n");
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
    result.sessions.push({ file, events, sha256 });
  }
  roots.forEach(root => visit(path.resolve(root)));
  return result;
}

export function aggregateMaintenance(sources, { from, to }) {
  const start=Date.parse(from),end=Date.parse(to);
  if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)throw new Error('Invalid maintenance telemetry window');
  const counts=Object.fromEntries(['baseline_uncertain','baseline_infrastructure_failure','model_failure',
    'verification_failure','cleanup_unknown','writer_dispatch_intents','strict_writer_starts','reviewer_starts',
    'result_only_writer_attempts'].map(k=>[k,new Set()]));
  const seen=new Set(),checks=new Map(),observedWriterStarts=new Set();let events=0,invalid_timestamps=0,missing_task_ids=0;
  const rows=sources.flatMap(source=>source.events.map(event=>({...event,file:source.file})))
    .sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  for(const event of rows){
    const at=Date.parse(event.at),d=event.data??{};
    if(!Number.isFinite(at)){invalid_timestamps++;continue;}if(at>=end)continue;
    if(!/^(task\/|check\/|implementation\/|codex\/|resource\/|container\/)/.test(event.type))continue;
    const task=d.task_id;
    if(!task){if(at>=start)missing_task_ids++;continue;}
    if(event.type==='check/start')checks.set(task,{check:d.check_id,phase:d.phase,owner:d.container_owner??'unknown-owner'});
    const check=checks.get(task),owner=d.container_owner??check?.owner??'unknown-owner';
    const key=[task,d.check_id??check?.check??'no-check',owner].join(':');
    const duplicate=[event.type,key,d.run_id??d.action_id??'',d.status??d.outcome?.status??'',d.phase??'',d.reason??''].join('|');
    if(seen.has(duplicate))continue;seen.add(duplicate);
    const attempt=[task,d.run_id??d.action_id??'unknown-run'].join(':');
    if(event.type==='codex/process-start'&&!d.action_id?.startsWith('review-'))observedWriterStarts.add(attempt);
    if(at<start)continue;events++;
    if(event.type==='task/transition'&&d.status==='uncertain'&&check?.phase==='baseline'){
      counts.baseline_uncertain.add(key);
      if(/container|environment|docker|inspect|runtime/i.test(d.reason??''))counts.baseline_infrastructure_failure.add(key);
    }
    if(event.type==='task/transition'&&d.status==='implementing')counts.writer_dispatch_intents.add(attempt);
    if(event.type==='codex/process-start'){
      if(d.action_id?.startsWith('review-'))counts.reviewer_starts.add(attempt);
      else counts.strict_writer_starts.add(attempt);
    }
    if(event.type==='implementation/result'){
      counts.result_only_writer_attempts.add(attempt);
      if(d.outcome?.status==='failed')counts.model_failure.add(attempt);
    }
    if(event.type==='check/result'&&d.phase==='candidate'&&d.status!=='PASS')counts.verification_failure.add(key);
    if(/^(resource|container)\/(cleanup|reconciled)$/.test(event.type)){
      const status=d.result?.status??d.status;
      if(!['absent','removed','stopped','confirmed'].includes(status))counts.cleanup_unknown.add(key);
    }
  }
  for(const attempt of observedWriterStarts)counts.result_only_writer_attempts.delete(attempt);
  return {scope:'maintenance-only',from,to,interval:'[from,to)',events,invalid_timestamps,missing_task_ids,
    ...Object.fromEntries(Object.entries(counts).map(([k,set])=>[k,set.size])),
    note:'Maintenance stage outcomes are separate from native production runs. Strict writer starts count only observed process-start times. Result-only attempts do not establish a start or its time. Complete cost remains unknown.',
    total_cost_usd:null};
}

export function main(argv) {
  const options = { roots: [], maintenanceRoots: [], sample: "unclassified" };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index], value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`);
    if (key === "--session-root") options.roots.push(value);
    else if (key === "--maintenance-events") options.maintenanceRoots.push(value);
    else if (["--from", "--to", "--timezone"].includes(key)) options[key.slice(2)] = value;
    else if (key === "--sample-kind") options.sample = value;
    else throw new Error(`Unknown option ${key}`);
  }
  if ((!options.roots.length&&!options.maintenanceRoots.length) || !options.timezone || ![options.from, options.to].every(value => typeof value === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)))
    throw new Error("Required: --from/--to ISO timestamps with offsets, --timezone, --session-root or --maintenance-events (repeatable); optional --sample-kind production|fixture|ci|unclassified");
  const { sessions, ...coverage } = readSessions(options.roots);
  const report = aggregate(sessions, options);
  const sources = sourceManifest(sessions, options);
  const {sessions:maintenanceSources,...maintenanceCoverage}=readSessions(options.maintenanceRoots);
  const maintenance={...aggregateMaintenance(maintenanceSources,options),...maintenanceCoverage,
    sources:sourceManifest(maintenanceSources,options).map(source=>({...source,
      sha256:maintenanceSources.find(item=>item.file===source.path)?.sha256??null}))};
  const incomplete = coverage.parse_errors.length || coverage.missing_sources.length || coverage.read_errors.length || coverage.skipped_symlinks.length || report.invalid_timestamps
    || maintenance.invalid_timestamps || maintenanceCoverage.parse_errors.length || maintenanceCoverage.missing_sources.length || maintenanceCoverage.read_errors.length || maintenanceCoverage.skipped_symlinks.length;
  return { ...report, maintenance, status: incomplete ? "incomplete" : maintenance.events || Object.values(report.groups).some(group => group.status === "samples") ? "samples" : "no_samples",
    source_status: coverage.missing_sources.length ? 'missing_source' : incomplete ? 'incomplete' :
      !sources.some(source => source.window_events) ? 'no_events' : report.groups.unclassified.events ? 'unclassified' : 'classified',
    session_files: sessions.length, sources, ...coverage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
