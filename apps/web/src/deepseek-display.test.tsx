import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Timeline } from './Timeline';
import { fromSnapshot, applyHostEvent, type Projection } from './projection';
import { fixtureSnapshot } from './timeline-fixture-data';
import { displayTranscript, type TranscriptView } from './transcript-display';
import type { AgentState, DurableEvent } from './types';

type EventData = [string, Record<string, unknown>];
const events = (values: EventData[]): DurableEvent[] => values.map(([type, data], i) => ({id:`e${i}`,seq:i+1,at:'2026-11-13T01:00:00Z',type,data}));
const render = (projection: Projection, view: TranscriptView = 'standard') => renderToStaticMarkup(createElement(Timeline, {projection,view,scrollRef:createRef<HTMLDivElement>()}));
const project = (values: EventData[], state: AgentState = {phase:'idle'}) => fromSnapshot({...fixtureSnapshot(0),events:events(values),state});
const message = (content: unknown, extra = {}): EventData => ['message', {message:{role:'assistant',content,...extra}}];

test('every collapsed summary distinguishes execution from verification', () => {
  const p=project([message('answer',{reasoning_content:'analysis'}),
    ['agent/run/end',{'run-id':'r',status:'completed',verification:'not-run'}]]);
  for(const mode of ['compact','standard','detailed'] as const) {
    assert.match(displayTranscript(p.timeline,mode,new Map()).rows.find(r=>r.kind==='turn-control')!.caption,/尚未验收/);
  }
});

test('empty structured content is not an answer or an empty timeline row', () => {
  const p = project([message([]),message([{type:'text',text:''}])]);
  assert.equal(p.timeline.rows.length,0);
});

test('empty content cannot steal the final answer when a completed turn folds', () => {
  const p = project([message('The final answer'),message([], {reasoning_content:'trace'}),
    ['agent/run/end',{'run-id':'r',status:'completed',verification:'not-run'}]]);
  for (const mode of ['compact','standard','detailed','verbose'] as const) {
    assert.match(render(p, mode),/The final answer/);
    const view=displayTranscript(p.timeline,mode,new Map());
    if (mode !== 'verbose') assert.match(view.rows.find(r=>r.kind==='turn-control')!.caption,/尚未验收/);
  }
});

test('stream reasoning is complete once answer text starts and stale non-model partials are hidden', () => {
  const p=project([],{phase:'model','partial-reasoning':'reason','partial-assistant':'answer'});
  assert.match(render(p),/已完成分析/);
  assert.doesNotMatch(render(p),/正在思考/);
  for (const phase of ['tool','retry','compacting','idle']) {
    assert.doesNotMatch(render({...p,state:{...p.state,phase}}),/is-streaming/);
  }
});

test('JSON structured answers and replay preserve content across all display views', () => {
  const values: EventData[]=[message([{type:'text',text:'first'},{type:'text',text:'second'}],{reasoning_content:'analysis'}),
    ['agent/run/end',{'run-id':'r',status:'completed',verification:'unknown'}]];
  const snapshot=project(values);
  let live=project([]);
  for(const e of events(values)) live=applyHostEvent(live,{hostSeq:e.seq,version:1,type:'event',durable:true,event:e.type,event_id:e.id,seq:e.seq,at:e.at,data:e.data});
  for(const view of ['compact','standard','detailed','verbose'] as const) {
    assert.equal(render(live,view),render(snapshot,view));
    assert.match(render(live,view),/first/); assert.match(render(live,view),/second/);
    assert.match(render(live,view),/验收结果未知/);
  }
});
