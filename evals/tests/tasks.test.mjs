import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assessTap } from '../lib/grading.mjs';

const tasksRoot = fileURLToPath(new URL('../tasks/', import.meta.url));
const taskNames = (await readdir(tasksRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

function inside(root, path) {
  assert.equal(typeof path, 'string');
  assert.ok(path.length > 0 && !isAbsolute(path), `expected a relative path: ${path}`);
  const resolved = resolve(root, path);
  const suffix = relative(root, resolved);
  assert.ok(suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`), `path escapes task workspace: ${path}`);
  return resolved;
}

test('exactly five synthetic development fixtures are present', () => {
  assert.equal(taskNames.length, 5);
});

for (const name of taskNames) {
  const taskRoot = join(tasksRoot, name);
  const task = JSON.parse(await readFile(join(taskRoot, 'task.json'), 'utf8'));
  test(`${name}: contract, known failing baseline, and passing reference`, async (t) => {
    assert.equal(task.id, name);
    assert.equal(task.split, 'dev');
    assert.equal(task.timeout_seconds, 180);
    assert.equal(typeof task.title, 'string');
    assert.equal(typeof task.category, 'string');
    assert.deepEqual(task.verify_command, ['node', '--test', 'tests/acceptance.test.mjs']);
    assert.ok(Array.isArray(task.allowed_files) && task.allowed_files.length > 0);
    assert.equal(new Set(task.allowed_files).size, task.allowed_files.length);
    assert.ok(Array.isArray(task.acceptance_tests) && task.acceptance_tests.length > 0);
    assert.equal(new Set(task.acceptance_tests).size, task.acceptance_tests.length);
    const acceptanceSource = await readFile(join(taskRoot, 'verifier/tests/acceptance.test.mjs'), 'utf8');
    const declaredTests = [...acceptanceSource.matchAll(/^test\('([^']+)'/gm)].map((match) => match[1]);
    assert.deepEqual(task.acceptance_tests, declaredTests, 'manifest must enumerate every trusted acceptance test');
    const prompt = await readFile(join(taskRoot, 'prompt.md'), 'utf8');
    assert.match(prompt, /合成开发题/);
    for (const path of task.allowed_files) {
      for (const tree of ['workspace', 'solution']) {
        const source = inside(join(taskRoot, tree), path);
        assert.equal((await lstat(source)).isFile(), true, `${tree}/${path} must be a regular file`);
      }
      assert.ok(prompt.includes(path), `prompt must name allowed source ${path}`);
    }
    const temporary = await mkdtemp(join(tmpdir(), 'qi-eval-fixture-'));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    for (const mode of ['baseline', 'reference']) {
      // Each candidate is evaluated on a fresh workspace. Agent-written test files
      // are never copied; only declared source files may replace the baseline.
      const workspace = join(temporary, mode);
      await cp(join(taskRoot, 'workspace'), workspace, { recursive: true });
      if (mode === 'reference') {
        for (const path of task.allowed_files) {
          const target = inside(workspace, path);
          await mkdir(dirname(target), { recursive: true });
          await cp(inside(join(taskRoot, 'solution'), path), target);
        }
      }
      await cp(join(taskRoot, 'verifier'), workspace, { recursive: true });
      const result = spawnSync(process.execPath, ['--test-reporter=tap', ...task.verify_command.slice(1)], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH ?? '', LANG: 'C', TZ: 'UTC', HOME: temporary,
          NODE_OPTIONS: '', NO_COLOR: '1' },
      });
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      assert.equal(result.error, undefined, `${mode} failed to execute: ${result.error}\n${output}`);
      assert.equal(result.signal, null, `${mode} terminated by signal: ${result.signal}\n${output}`);
      const assessment = assessTap(result.stdout, task.acceptance_tests);
      assert.equal(assessment.complete, true, `${mode} must execute every acceptance test: ${assessment.reason}\n${output}`);
      assert.equal(assessment.tests, task.acceptance_tests.length);
      if (mode === 'reference') {
        assert.equal(result.status, 0, `reference must pass acceptance:\n${output}`);
        assert.equal(assessment.passed, true, `reference must pass every named acceptance test: ${assessment.reason}\n${output}`);
        assert.equal(assessment.passed_tests, task.acceptance_tests.length);
      }
      else {
        assert.equal(result.status, 1, `baseline must fail assertion-based acceptance:\n${output}`);
        assert.equal(assessment.passed, false, `baseline must fail named acceptance tests:\n${output}`);
        assert.equal(assessment.reason, 'acceptance_assertions_failed');
        assert.match(output, /(?:ERR_ASSERTION|AssertionError)/, `baseline needs an assertion failure:\n${output}`);
        assert.doesNotMatch(output, /(?:ERR_MODULE_NOT_FOUND|SyntaxError)/, `baseline failure must not be infrastructure:\n${output}`);
      }
    }
  });
}
