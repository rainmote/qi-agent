import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('qi Harbor adapter contract and offline profile boot', () => {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const result = spawnSync('python3', ['-m', 'unittest', 'discover', '-s', 'evals/harbor', '-p', 'test_qi_agent.py', '-v'], {
    cwd: repo, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
