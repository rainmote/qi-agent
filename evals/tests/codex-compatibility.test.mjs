import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {codexDecoder,CODEX_VERSION} from '../../src/qi/external_cli_codex.mjs';
import {decodeCodex,defaults} from '../../maintenance/lib/codex.mjs';
const load=async name=>JSON.parse(await readFile(new URL('../fixtures/'+name,import.meta.url)));
const compatibility=await load('codex-compatibility.json');
test('each CLI use retains its pinned version and distinct authentication boundary',()=>{
  assert.equal(compatibility.uses[0].declared_cli_version,CODEX_VERSION);
  assert.equal(compatibility.uses[1].declared_cli_version,defaults.cli_version);
  assert.notEqual(compatibility.uses[0].authentication,compatibility.uses[1].authentication);
  assert.equal(compatibility.uses[0].live_success,'NOT_RUN');
});
for(const [name,status] of [['codex-exec-0.157.1.observed-failure.json','failed'],['codex-exec-0.162.observed-probe.json','completed']]){
  test('both pure decoders normalize the observed corpus: '+name,async()=>{
    const fixture=await load(name);assert.equal(fixture.observed_live_transcript,true);assert.match(fixture.raw_artifact_sha256,/^[a-f0-9]{64}$/);
    const decoder=codexDecoder();let terminal;for(const event of fixture.events)terminal=decoder.accept(event);
    const supervised=decodeCodex({exit_code:fixture.exit_code,stdout:fixture.events.map(e=>JSON.stringify(e)).join('\n')});
    assert.equal(terminal.status,status);assert.equal(supervised.status,status);
    if(status==='failed'){assert.equal(terminal.reason,'codex-model-unavailable');assert.equal(supervised.reason,terminal.reason);}
    else {assert.equal(fixture.executable_sha256,null);assert.ok(fixture.redactions.includes('agent_message.text'));}
  });
}
