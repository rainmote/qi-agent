#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTasks, offlineTrial, runProcess, cleanEnvironment, sha256, treeHash, filesIn } from './lib/core.mjs';
import { writeReport } from './lib/report.mjs';
import { buildInvocation } from './lib/adapters.mjs';

const evalRoot = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(evalRoot);
const help = `qì agent evaluation development kit (no real model calls by default)

  node evals/run.mjs doctor
  node evals/run.mjs list
  node evals/run.mjs validate [--task ID] [--out NEW_DIRECTORY]
  node evals/run.mjs smoke [--repeat 3] [--task ID] [--out NEW_DIRECTORY]
  node evals/run.mjs plan --config FILE [--agents qi,codex,claude] [--task ID] [--out NEW_DIRECTORY]
  node evals/run.mjs export-harbor --out NEW_DIRECTORY [--task ID]
  node evals/run.mjs report --input RUN_DIRECTORY

validate: prove each buggy baseline fails and its reference solution passes.
smoke: repeat noop/oracle runs through the same fresh-workspace verifier/report pipeline.
plan: emit explicit CLI argv without executing any agent or loading credentials.
export-harbor: create tasks for isolated real-agent evaluation; Docker/Harbor required to run.

Local validation is for the checked-in trusted development fixtures only.
It is NOT a security sandbox and does not accept arbitrary generated code.
`;

function optionsFrom(argv) {
  const options = { command: argv[0] || 'help' };
  const allowed = new Set(['--task', '--out', '--repeat', '--config', '--agents', '--input']);
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!allowed.has(flag) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Invalid option: ' + flag);
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) throw new Error('Repeated option: ' + flag);
    options[name] = argv[index + 1];
  }
  return options;
}

async function newOutput(requested, label) {
  const name = new Date().toISOString().replace(/[:.]/g, '-') + '-' + label;
  const output = path.resolve(requested || path.join(evalRoot, 'results', name));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output, { mode: 0o700 }); // Refuse to overwrite an earlier experiment.
  return output;
}

async function doctor() {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-eval-doctor-'));
  try {
    const checks = {};
    for (const [name, command, args] of [
      ['node', process.execPath, ['--version']], ['babashka', 'bb', ['--version']],
      ['codex', 'codex', ['--version']], ['claude', 'claude', ['--version']],
      ['docker', 'docker', ['version', '--format', '{{.Server.Version}}']], ['harbor', 'harbor', ['--version']],
    ]) {
      const result = await runProcess(command, args, { cwd: repository,
        env: cleanEnvironment(temporaryHome), timeoutMs: 5000, maxOutputBytes: 10000 });
      checks[name] = { available: result.exit_code === 0 && !result.timed_out,
        version: result.exit_code === 0 ? result.stdout.trim().slice(0, 500) : null,
        reason: result.exit_code === 0 ? null : result.error ? 'executable_unavailable' : result.timed_out ? 'timeout' : 'version_probe_failed' };
    }
    return { schema_version: 1, platform: process.platform, architecture: process.arch,
      checks, credentials_checked: false, model_access_checked: false,
      note: 'Availability does not prove authentication, model access, or container integration.' };
  } finally { await fs.rm(temporaryHome, { recursive: true, force: true }); }
}

async function provenance(tasks) {
  const gitHead = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: repository, timeoutMs: 5000 });
  const gitStatus = await runProcess('git', ['status', '--porcelain=v1', '-uall'], { cwd: repository, timeoutMs: 5000 });
  const parts = [];
  for (const folder of ['src', 'plugins']) parts.push(folder + ':' + await treeHash(path.join(repository, folder)));
  for (const file of ['agent.edn', 'bb.edn']) parts.push(file + ':' + sha256(await fs.readFile(path.join(repository, file))));
  const evaluatorParts = [];
  for (const folder of ['lib', 'harbor', 'tests']) {
    for (const file of await filesIn(path.join(evalRoot, folder))) {
      if (file.split('/').includes('__pycache__') || file.endsWith('.pyc')) continue;
      evaluatorParts.push(folder + '/' + file + ':' + sha256(await fs.readFile(path.join(evalRoot, folder, file))));
    }
  }
  evaluatorParts.push('run.mjs:' + sha256(await fs.readFile(path.join(evalRoot, 'run.mjs'))));
  return { node: process.version, platform: process.platform, architecture: process.arch,
    agent_commit: gitHead.exit_code === 0 ? gitHead.stdout.trim() : null,
    working_tree_dirty: gitStatus.exit_code === 0 ? Boolean(gitStatus.stdout.trim()) : null,
    agent_source_hash: sha256(parts.join('\n')),
    evaluator_source_hash: sha256(evaluatorParts.join('\n')),
    dataset_hash: sha256(tasks.map((task) => task.id + ':' + task.hash).join('\n')),
    tasks: tasks.map((task) => ({ id: task.id, hash: task.hash, split: task.split })),
    note: 'Source hash covers src/, plugins/, agent.edn and bb.edn including uncommitted contents; not a deployed binary fingerprint.' };
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  if (['help', '--help', '-h'].includes(options.command)) { console.log(help); return; }
  if (options.command === 'doctor') { console.log(JSON.stringify(await doctor(), null, 2)); return; }
  if (options.command === 'report') {
    if (!options.input) throw new Error('--input is required');
    const root = path.resolve(options.input);
    const metadata = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
    const records = (await fs.readFile(path.join(root, 'results.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    if (!records.length) throw new Error('No results to report');
    await writeReport(root, records, metadata);
    console.log(path.join(root, 'report.html'));
    return;
  }
  if (!['list', 'validate', 'smoke', 'plan', 'export-harbor'].includes(options.command)) throw new Error('Unknown command: ' + options.command);
  const tasks = await loadTasks(path.join(evalRoot, 'tasks'), options.task ? options.task.split(',') : []);
  if (options.command === 'list') {
    console.log(JSON.stringify(tasks.map(({ id, title, category, split, timeout_seconds, hash }) =>
      ({ id, title, category, split, timeout_seconds, hash })), null, 2)); return;
  }
  if (options.command === 'export-harbor') {
    if (!options.out) throw new Error('--out is required and must not already exist');
    const { exportHarbor } = await import('./harbor/export.mjs');
    const result = await exportHarbor({ tasksRoot: path.join(evalRoot, 'tasks'), outputDir: path.resolve(options.out),
      taskIds: tasks.map((task) => task.id) });
    console.log(JSON.stringify(result, null, 2)); return;
  }
  const repeat = options.command === 'validate' ? 1 : Number(options.repeat || 3);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) throw new Error('--repeat must be 1..20');
  const metadata = await provenance(tasks);
  if (options.command === 'plan') {
    if (!options.config) throw new Error('--config is required; never inherit a personal model default');
    const configText = await fs.readFile(path.resolve(options.config), 'utf8');
    const config = JSON.parse(configText);
    const agents = (options.agents || 'qi,codex,claude').split(',');
    if (new Set(agents).size !== agents.length || agents.some((agent) => !['qi', 'codex', 'claude'].includes(agent))) throw new Error('Invalid --agents');
    // Validate all configurations before creating any plan artifacts.
    for (const agent of agents) buildInvocation({ agent, config,
      workspace: path.join(os.tmpdir(), 'qi-eval-plan-workspace'), prompt: tasks[0].prompt,
      runDir: path.join(os.tmpdir(), 'qi-eval-plan-run') });
    const output = await newOutput(options.out, 'plan');
    const invocations = [];
    for (const task of tasks) for (const agent of agents) {
      const runDir = path.join(output, 'planned', task.id, agent);
      const workspace = path.join(runDir, 'workspace');
      invocations.push({ task: task.id, agent, cwd: workspace, timeout_seconds: task.timeout_seconds,
        ...buildInvocation({ agent, workspace, prompt: task.prompt, config, runDir }) });
    }
    const plan = { ...metadata, mode: 'plan_only', config_hash: sha256(configText),
      invocations, blockers: ['Command plans do not establish filesystem isolation, authentication or access.',
        'Use a fresh container per live trial and separate verifier; do not execute plans directly on the developer checkout.',
        'qi profile must pin main/child models and supply isolated trust, approval, state and Linux execution-world settings.',
        'Missing usage is unknown, not zero. No live cost enforcement is implemented in this local development kit.'] };
    await fs.writeFile(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { mode: 0o600 });
    console.log(path.join(output, 'plan.json')); return;
  }
  const output = await newOutput(options.out, options.command);
  const manifest = { ...metadata, command: options.command, repetitions: repeat, mode: 'offline_fixture',
    created_at: new Date().toISOString(), model_calls: 0,
    isolation: 'fresh_directories_trusted_fixtures_only',
    protocol: 'baseline must fail; reference must pass; trusted verifier runs in a fresh directory with only allowed deliverables',
    limitations: ['Synthetic development fixtures; not held-out tasks.', 'No security sandbox for local validation.',
      'No model ranking, billing estimate, or statistical superiority claim.'] };
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  const records = [];
  for (const task of tasks) for (let trial = 1; trial <= repeat; trial++) {
    // Alternate reference/baseline ordering; this is a plumbing test, not a randomized model experiment.
    for (const agent of trial % 2 ? ['noop', 'oracle'] : ['oracle', 'noop']) {
      const record = await offlineTrial(task, agent, trial, output);
      record.dataset_hash = metadata.dataset_hash;
      record.evaluator_source_hash = metadata.evaluator_source_hash;
      record.agent_source_hash = metadata.agent_source_hash;
      await fs.writeFile(path.join(output, 'runs', record.run_id, 'result.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      records.push(record);
      await fs.appendFile(path.join(output, 'results.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
      console.log(task.id + ' · ' + agent + ' · ' + trial + ' · ' + (record.success ? 'PASS' : agent === 'noop' ? 'FAIL (baseline expected)' : 'FAIL (unexpected)'));
    }
  }
  await writeReport(output, records, manifest);
  const invalid = records.filter((record) => !record.verification.tap.complete ||
    (record.agent === 'oracle' ? !record.success : record.success));
  console.log('Report: ' + path.join(output, 'report.html'));
  if (invalid.length) throw new Error('Fixture validation failed for ' + invalid.length + ' attempts; inspect logs');
}

main().catch((error) => { console.error('Evaluation error: ' + error.message); process.exitCode = 1; });
