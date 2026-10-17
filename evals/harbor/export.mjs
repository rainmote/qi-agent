import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HARBOR_SOURCE_COMMIT = 'bf991e490394ef9c3250a6db2bc5cbda903cb4c3';
export const DEFAULT_NODE_IMAGE = 'node:22.14.0-bookworm-slim';
const here = path.dirname(fileURLToPath(import.meta.url));

function safeRelative(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
      value.startsWith('/') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

async function filesIn(directory, prefix = '') {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real directory: ${directory}`);
  const result = [];
  for (const entry of (await readdir(directory)).sort()) {
    const relative = prefix ? `${prefix}/${entry}` : entry;
    safeRelative(relative, 'file path');
    const filename = path.join(directory, entry);
    const item = await lstat(filename);
    if (item.isSymbolicLink()) throw new Error(`Symlinks are not exportable: ${filename}`);
    if (item.isDirectory()) result.push(...await filesIn(filename, relative));
    else if (item.isFile()) result.push({ relative, filename });
    else throw new Error(`Special files are not exportable: ${filename}`);
  }
  return result;
}

async function copyTree(source, target) {
  const files = await filesIn(source);
  await mkdir(target, { recursive: true });
  for (const { relative, filename } of files) {
    const destination = path.join(target, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(filename, destination);
  }
  return files;
}

async function loadTask(tasksRoot, id) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`Invalid task id: ${id}`);
  const root = path.join(tasksRoot, id);
  const taskStat = await lstat(root);
  if (!taskStat.isDirectory() || taskStat.isSymbolicLink()) throw new Error(`Invalid task directory: ${id}`);
  const manifestStat = await lstat(path.join(root, 'task.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error(`Invalid task.json: ${id}`);
  const task = JSON.parse(await readFile(path.join(root, 'task.json'), 'utf8'));
  if (task.id !== id || task.split !== 'dev') throw new Error(`Only matching dev tasks can be exported: ${id}`);
  if (!Number.isInteger(task.timeout_seconds) || task.timeout_seconds < 1) throw new Error(`Invalid timeout: ${id}`);
  if (!Array.isArray(task.allowed_files) || !task.allowed_files.length ||
      new Set(task.allowed_files).size !== task.allowed_files.length) throw new Error(`Invalid allowed_files: ${id}`);
  for (const name of task.allowed_files) safeRelative(name, 'allowed file');
  if (!Array.isArray(task.acceptance_tests) || !task.acceptance_tests.length ||
      task.acceptance_tests.some(name => typeof name !== 'string' || !name.trim()) ||
      new Set(task.acceptance_tests).size !== task.acceptance_tests.length) {
    throw new Error(`Invalid acceptance_tests: ${id}`);
  }
  // This bridge deliberately supports only the dependency-free Node pilot contract.
  if (!Array.isArray(task.verify_command) || task.verify_command.length < 3 ||
      task.verify_command[0] !== 'node' || task.verify_command[1] !== '--test') {
    throw new Error(`Unsupported verify_command for ${id}; expected node --test <files>`);
  }
  for (const argument of task.verify_command.slice(2)) {
    safeRelative(argument, 'test path');
    if (!argument.startsWith('tests/') || !argument.endsWith('.mjs')) throw new Error(`Unsupported test path: ${argument}`);
  }
  const sourceFiles = await filesIn(root);
  const digest = createHash('sha256');
  for (const file of sourceFiles) {
    const bytes = await readFile(file.filename);
    digest.update(`${file.relative}\0${bytes.length}\0`).update(bytes);
  }
  const workspace = await filesIn(path.join(root, 'workspace'));
  const solution = await filesIn(path.join(root, 'solution'));
  const verifier = await filesIn(path.join(root, 'verifier'));
  const workspacePaths = new Set(workspace.map(file => file.relative));
  if (!solution.length || solution.some(file => !task.allowed_files.includes(file.relative))) {
    throw new Error(`Solution contains no files or non-deliverable files: ${id}`);
  }
  for (const name of task.allowed_files) {
    if (!workspacePaths.has(name)) throw new Error(`This pilot requires existing allowed files: ${id}/${name}`);
  }
  const gradingPaths = new Set([...workspace, ...verifier].map(file => file.relative));
  for (const test of task.verify_command.slice(2)) {
    if (!gradingPaths.has(test)) throw new Error(`Missing acceptance file: ${id}/${test}`);
  }
  for (const file of verifier) {
    if (task.allowed_files.includes(file.relative)) throw new Error(`Verifier overlaps deliverable: ${id}/${file.relative}`);
  }
  return { root, task, digest: digest.digest('hex') };
}

function taskToml(task) {
  const quote = JSON.stringify;
  return `schema_version = "1.4"
artifacts = [${task.allowed_files.map(file => quote(`/app/${file}`)).join(', ')}]

[metadata]
category = ${quote(task.category ?? 'coding')}
split = "dev"
source_task_id = ${quote(task.id)}
title = ${quote(task.title ?? task.id)}

[agent]
timeout_sec = ${task.timeout_seconds}

[verifier]
timeout_sec = 60
environment_mode = "separate"

[verifier.environment]
network_mode = "no-network"
cpus = 1
memory_mb = 1024

[environment]
workdir = "/app"
network_mode = "public"
cpus = 1
memory_mb = 1024
`;
}

/** Export a fresh Harbor dataset. No model calls, package installs, or source mutation. */
export async function exportHarbor({ tasksRoot, outputDir, taskIds, nodeImage = DEFAULT_NODE_IMAGE }) {
  if (!tasksRoot || !outputDir) throw new Error('tasksRoot and outputDir are required');
  const source = path.resolve(tasksRoot);
  const destination = path.resolve(outputDir);
  if (destination === source || destination.startsWith(`${source}${path.sep}`)) throw new Error('Output must be outside tasksRoot');
  if (typeof nodeImage !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(nodeImage)) throw new Error('Invalid nodeImage');
  try { await lstat(destination); throw new Error(`Refusing to overwrite output: ${destination}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ids = taskIds ?? (await readdir(source, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new Error('taskIds must be nonempty and unique');
  const tasks = [];
  for (const id of ids) tasks.push(await loadTask(source, id));
  await mkdir(path.dirname(destination), { recursive: true });
  const staging = `${destination}.partial-${randomUUID()}`;
  await mkdir(staging);
  try {
    for (const { root, task } of tasks) {
      const out = path.join(staging, task.id);
      await mkdir(out);
      await copyFile(path.join(root, 'prompt.md'), path.join(out, 'instruction.md'));
      await writeFile(path.join(out, 'task.toml'), taskToml(task));
      await copyTree(path.join(root, 'workspace'), path.join(out, 'environment', 'workspace'));
      await writeFile(path.join(out, 'environment', 'Dockerfile'), `FROM ${nodeImage}\nWORKDIR /app\nCOPY workspace/ /app/\n`);
      await copyTree(path.join(root, 'workspace'), path.join(out, 'tests', 'workspace'));
      await copyTree(path.join(root, 'verifier'), path.join(out, 'tests', 'verifier'));
      await copyFile(path.join(here, 'verify.mjs'), path.join(out, 'tests', 'verify.mjs'));
      await copyFile(path.join(here, '..', 'lib', 'grading.mjs'), path.join(out, 'tests', 'grading.mjs'));
      await writeFile(path.join(out, 'tests', 'manifest.json'), `${JSON.stringify(task, null, 2)}\n`);
      await writeFile(path.join(out, 'tests', 'Dockerfile'), `FROM ${nodeImage}\nWORKDIR /\nCOPY . /tests/\nRUN chmod -R a+rX /tests\n`);
      await writeFile(path.join(out, 'tests', 'test.sh'), '#!/bin/sh\nset -eu\nexec node /tests/verify.mjs\n', { mode: 0o755 });
      await copyTree(path.join(root, 'solution'), path.join(out, 'solution', 'files'));
      await writeFile(path.join(out, 'solution', 'solve.sh'), '#!/bin/sh\nset -eu\ncp -R /solution/files/. /app/\n', { mode: 0o755 });
    }
    const manifest = {
      format: 1, harbor_source_commit: HARBOR_SOURCE_COMMIT, harbor_source_version: '0.23.0',
      node_image: nodeImage, container_integration_validated: false,
      evaluator_sha256: Object.fromEntries(await Promise.all([
        ['export.mjs', path.join(here, 'export.mjs')],
        ['verify.mjs', path.join(here, 'verify.mjs')],
        ['grading.mjs', path.join(here, '..', 'lib', 'grading.mjs')],
      ].map(async ([name, file]) => [name, createHash('sha256').update(await readFile(file)).digest('hex')]))),
      tasks: tasks.map(({ task, digest }) => ({ id: task.id, source_sha256: digest })),
    };
    await writeFile(path.join(staging, 'export-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(staging, destination);
    return { outputDir: destination, tasks: ids, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node evals/harbor/export.mjs <tasks-root> <new-output-dir> [task-id ...]');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(await exportHarbor({ tasksRoot: args[0], outputDir: args[1], taskIds: args.length > 2 ? args.slice(2) : undefined }), null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
