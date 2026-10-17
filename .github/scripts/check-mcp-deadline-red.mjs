// The same integration regression must fail on the actual pre-fix target.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const target = '37ab7446e0381121cbdaf8c2d59b6b5d681a3319';
const root = mkdtempSync(path.join(process.env.RUNNER_TEMP, 'mcp-deadline-red-'));
mkdirSync(path.join(root, 'qi'));
writeFileSync(path.join(root, 'qi/mcp_stdio.clj'),
  execFileSync('git', ['show', `${target}:src/qi/mcp_stdio.clj`]));
const result = spawnSync('bb', ['--classpath', `${root}:src:test`, '-e',
  `(require 'qi.mcp-deadline-test '[clojure.test :as t])
   (let [r (t/run-tests 'qi.mcp-deadline-test)]
     (prn {:frozen-target "${target}" :test-summary r})
     (System/exit (if (= {:test 2 :pass 8 :fail 1 :error 0}
                        (select-keys r [:test :pass :fail :error])) 0 1)))`],
{ encoding: 'utf8', timeout: 30000 });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0);
assert.match(result.stdout, /FAIL in \(late-reply-cannot-win-while-requesting-thread-is-paused\)/);
assert.match(result.stdout, /the deadline includes the caller's scheduling pause/);
assert.match(result.stdout, /1 failures, 0 errors/);
console.log(`Verified the behavioral timeout assertion fails against ${target}; timely-completion control passed.`);
