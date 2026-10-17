// Prove the current regression assertions fail against the actual frozen target.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const target = '6777e2fdacb85b0e6cbea6b38f6f45c43ff39ade';
const root = mkdtempSync(path.join(process.env.RUNNER_TEMP, 'external-cli-red-'));
for (const name of ['external_cli.mjs', 'external_cli_codex.mjs']) {
  writeFileSync(path.join(root, name), execFileSync('git', ['show', `${target}:src/qi/${name}`]));
}
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'evals/tests/external-cli-signals.test.mjs'], {
  encoding: 'utf8', timeout: 30000,
  env: { ...process.env, QI_EXTERNAL_CLI_MODULE: pathToFileURL(path.join(root, 'external_cli.mjs')).href }
});
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
for (const summary of ['tests 4', 'pass 1', 'fail 3', 'cancelled 0', 'skipped 0']) {
  assert.match(result.stdout, new RegExp(`^# ${summary}$`, 'm'));
}
assert.equal((result.stdout.match(/code: 'ERR_ASSERTION'/g) ?? []).length, 3);
assert.equal((result.stdout.match(/Got unwanted exception\./g) ?? []).length, 3);
console.log(`Verified three behavioral assertion failures against ${target}; ESRCH control passed.`);
