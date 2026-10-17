import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {aggregateMaintenance,aggregate} from '../report-telemetry.mjs';
const sources=JSON.parse(readFileSync(new URL('../fixtures/observed-baseline-20261016.json',import.meta.url)));
const window={from:'2026-10-16T00:00:00+08:00',to:'2026-10-17T00:00:00+08:00',timezone:'Asia/Singapore'};
test('observed infrastructure failures remain separate from native production and deduplicate copies',()=>{
  const one=aggregateMaintenance(sources,window),twice=aggregateMaintenance([...sources,...sources],window);
  assert.deepEqual(twice,one);assert.equal(one.baseline_uncertain,2);assert.equal(one.baseline_infrastructure_failure,2);
  assert.equal(one.strict_writer_starts,0);assert.equal(one.model_failure,0);assert.equal(one.total_cost_usd,null);
  assert.equal(aggregate([],window).groups.production.failure_rate,null);
  assert.equal(aggregateMaintenance(sources,{...window,from:window.to,to:'2026-10-18T00:00:00+08:00'}).baseline_uncertain,0);
  assert.ok(sources.every(source=>/^[a-f0-9]{64}$/.test(source.raw_sha256)));
});
test('writer intent, observed process, model failure, verification and unknown cleanup have distinct counts',()=>{
  const at='2026-10-16T12:00:00+08:00',event=(type,data)=>({at,type,data:{task_id:'fixture',...data}});
  const records=[event('task/transition',{status:'implementing',run_id:'r'}),
    event('codex/process-start',{run_id:'r',action_id:'codex-r'}),
    event('implementation/result',{run_id:'r',outcome:{status:'failed'}}),
    event('check/start',{check_id:'verify',phase:'candidate',container_owner:'owner'}),
    event('check/result',{check_id:'verify',phase:'candidate',status:'FAIL'}),
    event('container/cleanup',{status:'UNKNOWN'}),event('codex/process-start',{action_id:'review-r'})];
  const r=aggregateMaintenance([{file:'fixture.jsonl',events:records}],window);
  assert.equal(r.writer_dispatch_intents,1);assert.equal(r.strict_writer_starts,1);assert.equal(r.model_failure,1);
  assert.equal(r.verification_failure,1);assert.equal(r.cleanup_unknown,1);assert.equal(r.reviewer_starts,1);assert.equal(r.baseline_uncertain,0);
  assert.equal(r.result_only_writer_attempts,0);
});

test('launch failure without process-start remains a result-only attempt',()=>{
  const events=[{at:'2026-10-16T12:00:00+08:00',type:'implementation/result',
    data:{task_id:'fixture',run_id:'failed-launch',outcome:{status:'failed'}}}];
  const r=aggregateMaintenance([{file:'fixture.jsonl',events}],window);
  assert.equal(r.strict_writer_starts,0);assert.equal(r.result_only_writer_attempts,1);assert.equal(r.model_failure,1);
});

test('prior-window start and current-window result never create another start',()=>{
  const events=[{at:'2026-10-15T23:59:59+08:00',type:'codex/process-start',data:{task_id:'fixture',run_id:'r'}},
    {at:'2026-10-16T00:00:00+08:00',type:'implementation/result',data:{task_id:'fixture',run_id:'r',outcome:{status:'completed'}}}];
  const r=aggregateMaintenance([{file:'fixture.jsonl',events}],window);
  assert.equal(r.strict_writer_starts,0);assert.equal(r.result_only_writer_attempts,0);
});

test('out-of-order duplicate sources preserve start-time boundaries and separate reviewers',()=>{
  const event=(at,type,data)=>({at,type,data:{task_id:'fixture',...data}});
  const events=[event(window.from,'codex/process-start',{run_id:'observed'}),
    event('2026-10-16T12:00:00+08:00','implementation/result',{run_id:'observed'}),
    event('2026-10-16T12:00:01+08:00','implementation/result',{run_id:'inferred'}),
    event('2026-10-16T12:00:02+08:00','codex/process-start',{action_id:'review-one'}),
    event(window.to,'codex/process-start',{run_id:'at-end'})];
  const r=aggregateMaintenance([{file:'first.jsonl',events:[...events].reverse()},{file:'copy.jsonl',events}],window);
  assert.equal(r.strict_writer_starts,1);assert.equal(r.result_only_writer_attempts,1);assert.equal(r.reviewer_starts,1);
  assert.equal(r.total_cost_usd,null);
});
