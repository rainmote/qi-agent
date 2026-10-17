import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportHarbor, HARBOR_SOURCE_COMMIT } from '../harbor/export.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qi-harbor-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tasksRoot = path.join(root, 'tasks');
  const taskRoot = path.join(tasksRoot, 'pilot');
  const manifest = { id: 'pilot', title: 'Pilot', category: 'bugfix', split: 'dev', timeout_seconds: 180,
    allowed_files: ['src/math.mjs'], verify_command: ['node', '--test', 'tests/acceptance.test.mjs'],
    acceptance_tests: ['adds two numbers'] };
  const files = {
    'task.json': JSON.stringify(manifest),
    'prompt.md': 'Fix add in src/math.mjs.\n',
    'workspace/src/math.mjs': 'export const add = (a, b) => a - b;\n',
    'workspace/tests/public.test.mjs': 'import test from "node:test"; test("smoke", () => {});\n',
    'verifier/tests/acceptance.test.mjs': '// HIDDEN_ACCEPTANCE_SENTINEL\n',
    'solution/src/math.mjs': '// ORACLE_SENTINEL\nexport const add = (a, b) => a + b;\n',
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(taskRoot, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { root, tasksRoot, taskRoot, manifest, outputDir: path.join(root, 'export') };
}

async function allText(root) {
  let result = '';
  for (const file of await readdir(root, { withFileTypes: true })) {
    const name = path.join(root, file.name);
    result += file.isDirectory() ? await allText(name) : await readFile(name, 'utf8');
  }
  return result;
}

test('exports a separate-verifier dataset without solutions or hidden tests in agent build context', async t => {
  const input = await fixture(t);
  const result = await exportHarbor(input);
  assert.deepEqual(result.tasks, ['pilot']);
  assert.equal(result.manifest.harbor_source_commit, HARBOR_SOURCE_COMMIT);
  assert.equal(result.manifest.container_integration_validated, false);
  assert.deepEqual(Object.keys(result.manifest.evaluator_sha256).sort(), ['export.mjs', 'grading.mjs', 'verify.mjs']);
  for (const digest of Object.values(result.manifest.evaluator_sha256)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.match(result.manifest.tasks[0].source_sha256, /^[a-f0-9]{64}$/);
  const base = path.join(input.outputDir, 'pilot');
  const environment = await allText(path.join(base, 'environment'));
  assert.doesNotMatch(environment, /HIDDEN_ACCEPTANCE_SENTINEL|ORACLE_SENTINEL/);
  assert.match(await readFile(path.join(base, 'tests/verifier/tests/acceptance.test.mjs'), 'utf8'), /HIDDEN_ACCEPTANCE_SENTINEL/);
  assert.match(await readFile(path.join(base, 'solution/files/src/math.mjs'), 'utf8'), /ORACLE_SENTINEL/);
  const toml = await readFile(path.join(base, 'task.toml'), 'utf8');
  assert.match(toml, /environment_mode = "separate"/);
  assert.match(toml, /artifacts = \["\/app\/src\/math.mjs"\]/);
  assert.match(toml, /\[verifier.environment\]\nnetwork_mode = "no-network"/);
  for (const relative of ['tests/test.sh', 'solution/solve.sh']) {
    const check = spawnSync('sh', ['-n', path.join(base, relative)], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
  }
  assert.equal(spawnSync(process.execPath, ['--check', path.join(base, 'tests/verify.mjs')]).status, 0);
  assert.match(await readFile(path.join(base, 'tests/verify.mjs'), 'utf8'), /assessTap\(result.stdout/);
  assert.match(await readFile(path.join(base, 'tests/grading.mjs'), 'utf8'), /assessTap/);
});

test('export refuses overwrites and keeps task hashes stable', async t => {
  const input = await fixture(t);
  const first = await exportHarbor(input);
  await assert.rejects(exportHarbor(input), /Refusing to overwrite/);
  const second = await exportHarbor({ ...input, outputDir: path.join(input.root, 'second') });
  assert.deepEqual(first.manifest, second.manifest);
  await writeFile(path.join(input.taskRoot, 'prompt.md'), 'Changed instructions');
  const third = await exportHarbor({ ...input, outputDir: path.join(input.root, 'third') });
  assert.notEqual(first.manifest.tasks[0].source_sha256, third.manifest.tasks[0].source_sha256);
});

test('rejects path escapes and symlinks before publishing output', async t => {
  const input = await fixture(t);
  await assert.rejects(exportHarbor({ ...input, taskIds: ['../pilot'] }), /Invalid task id/);
  input.manifest.allowed_files = ['../escape'];
  await writeFile(path.join(input.taskRoot, 'task.json'), JSON.stringify(input.manifest));
  await assert.rejects(exportHarbor(input), /Invalid allowed file/);
  input.manifest.allowed_files = ['src/math.mjs'];
  await writeFile(path.join(input.taskRoot, 'task.json'), JSON.stringify(input.manifest));
  await symlink(path.join(input.taskRoot, 'solution/src/math.mjs'), path.join(input.taskRoot, 'workspace/leaked.mjs'));
  await assert.rejects(exportHarbor(input), /Symlinks are not exportable/);
  await assert.rejects(readFile(path.join(input.outputDir, 'export-manifest.json')), { code: 'ENOENT' });
});

test('rejects unsupported grading commands and non-dev tasks', async t => {
  const input = await fixture(t);
  input.manifest.verify_command = ['sh', '-c', 'echo accepted'];
  await writeFile(path.join(input.taskRoot, 'task.json'), JSON.stringify(input.manifest));
  await assert.rejects(exportHarbor(input), /Unsupported verify_command/);
  input.manifest.split = 'heldout';
  await writeFile(path.join(input.taskRoot, 'task.json'), JSON.stringify(input.manifest));
  await assert.rejects(exportHarbor(input), /Only matching dev tasks/);
});

test('solution and verifier cannot overwrite grading policy through deliverables', async t => {
  const input = await fixture(t);
  await mkdir(path.join(input.taskRoot, 'verifier/src'));
  await writeFile(path.join(input.taskRoot, 'verifier/src/math.mjs'), 'grading override');
  await assert.rejects(exportHarbor(input), /Verifier overlaps deliverable/);
  await rm(path.join(input.taskRoot, 'verifier/src'), { recursive: true });
  await writeFile(path.join(input.taskRoot, 'solution/extra'), 'unlisted solution');
  await assert.rejects(exportHarbor(input), /Solution contains no files or non-deliverable files/);
});

test('requires a nonempty unique acceptance test inventory', async t => {
  const input = await fixture(t);
  for (const names of [undefined, [], [''], ['same', 'same']]) {
    input.manifest.acceptance_tests = names;
    await writeFile(path.join(input.taskRoot, 'task.json'), JSON.stringify(input.manifest));
    await assert.rejects(exportHarbor(input), /Invalid acceptance_tests/);
  }
});
