#!/usr/bin/env node
// Full qi repository/environment integration. The oracle is deliberately known;
// this is never used as held-out qualification or a real model success.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { git, immutableImage, snapshot, containerCommand } from './lib/execution.mjs';
import { lockStore, durableWrite, encode } from './lib/store.mjs';
import { prepare, implement } from './lib/controller.mjs';

const controller = fileURLToPath(new URL('..', import.meta.url));
const [base, output] = process.argv.slice(2);
if (!/^[a-f0-9]{40}$/.test(base ?? '') || !path.isAbsolute(output ?? '')) throw new Error('Usage: QI_MAINTENANCE_IMAGE=sha256:... node maintenance/qi-smoke.mjs EXACT_BASE_SHA ABS_NEW_OUTPUT');
const image = immutableImage(process.env.QI_MAINTENANCE_IMAGE);
await fs.mkdir(output); // Preserve earlier evidence.
const verifier = path.join(output, 'verifier'); await fs.mkdir(verifier);
const program = `(require '[qi.plugin :as p] '[qi.kernel :as k] '[cheshire.core :as json])
(let [ctx (p/boot! {:plugins [{:ns 'qi.plugins.session :config {:path nil :ephemeral true}}
                             {:ns 'qi.plugins.model-registry}
                             {:ns 'qi.plugins.mock :config {:generate (constantly {:message {:role "assistant" :content "summary"} :finish-reason "stop"})}}
                             {:ns 'qi.plugins.context-manager :config {:retain-messages 1 :max-source-chars 2000}}]})]
  (try (let [store (k/require-service ctx :session/store) manager (k/require-service ctx :context/manager)]
    ((:append! store) "message" {:message {:role "user" :content (apply str (repeat 6000 "x"))}})
    ((:append! store) "message" {:message {:role "user" :content "current instruction"}})
    ((:compact! manager) {:force true :run-id "acceptance-run"})
    (print (json/generate-string (map :data (filter #(and (= "usage/request" (:type %)) (= :completed (get-in % [:data :status]))) ((:events store)))))))
    (finally (k/dispose-all! ctx))))`;
await fs.writeFile(path.join(verifier, 'acceptance.test.mjs'), `import test from 'node:test';
import assert from 'node:assert/strict'; import {execFileSync} from 'node:child_process';
test('compaction requests preserve run and chunk identity', () => {
 const rows=JSON.parse(execFileSync('bb',['--classpath','src:plugins','-e',${JSON.stringify(program)}],{cwd:'/work',encoding:'utf8'}));
 assert.ok(rows.length>1); assert.ok(rows.every(r=>r['run-id']==='acceptance-run'));
 assert.ok(rows.every(r=>typeof r['compaction-id']==='string'));
 assert.equal(new Set(rows.map(r=>r['compaction-id'])).size,1);
 assert.deepEqual(rows.map(r=>r['chunk-index']),rows.map((_,i)=>i));
});\n`);
const profile = path.join(output, 'agent.edn'); await fs.writeFile(profile, '{:plugins []}\n');
const catalog = JSON.parse(await fs.readFile(new URL('checks.json', import.meta.url)));
const task = { schema_version: 1, task_id: 'qi-compaction-container', split: 'dev', kind: 'bug', base_sha: base, image,
  goal: 'Preserve run and chunk identities in compaction request accounting.', profile_path: profile, verifier_dir: verifier,
  resources: { cpus: 4, memory_mb: 6144, work_mb: 6144, tmp_mb: 1024, pids: 1024 },
  allowed_files: ['src/qi/generation.clj', 'src/qi/plugins/context_manager.clj'],
  checks: [...catalog.checks, ...catalog.web_checks],
  acceptance: { file: 'acceptance.test.mjs', tests: ['compaction requests preserve run and chunk identity'] } };
const policy = JSON.parse(await fs.readFile(new URL('policy.json', import.meta.url)));
const root = path.join(output, 'state'), lock = await lockStore(root);
try {
  await prepare({ root, lock, repo: controller, controller, task, policy });
  const driver = { mode: 'offline', paid: false, unattended: false, argv: ['node', '-e',
    `const fs=require('node:fs'); for(const f of ${JSON.stringify(task.allowed_files)}) fs.copyFileSync('/controller/'+f,'/work/'+f);`] };
  const result = await implement({ root, lock, id: task.task_id, driver });
  const currentSource = path.join(output, 'current-source');
  await snapshot(controller, git(controller, 'rev-parse', 'HEAD'), currentSource);
  const currentSuite = await containerCommand({ image, workspace: currentSource, readonly: true, resources: task.resources,
    argv: ['npm', 'test'], timeoutMs: 900_000 });
  const report = { schema_version: 1, status: result.status === 'review_ready' ? 'PASS' : 'FAIL', mode: 'full-qi-offline-oracle',
    model_calls: 0, source_sha: git(controller, 'rev-parse', 'HEAD'), base_sha: base, image, resources: task.resources,
    task_status: result.status, reason: result.reason ?? null, checks: result.checks, evidence: result.evidence, candidate_sha: result.candidate_sha,
    current_source_suite: currentSuite };
  if (currentSuite.exit_code !== 0) report.status = 'FAIL';
  await durableWrite(path.join(output, 'report.json'), encode(report));
  console.log(encode(report));
  assert.equal(result.status, 'review_ready');
  assert.equal(currentSuite.exit_code, 0, currentSuite.stderr);
} catch (error) {
  await durableWrite(path.join(output, 'failure.json'), encode({ status: 'FAIL', reason: error.message, model_calls: 0 }));
  throw error;
} finally { await lock.close(); }
