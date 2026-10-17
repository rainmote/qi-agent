// Transport samples only: no release, executable payload, credentials or network calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const root = process.cwd();
const directory = path.resolve(process.env.ACCEPTANCE_ROOT);
const targets = ['linux-x86_64', 'linux-aarch64', 'macos-x86_64', 'macos-aarch64'];
const actions = {
  checkout: '3d3c42e5aac5ba805825da76410c181273ba90b1',
  upload: 'cf430e030ddbb5b0abf93d22962f4752f3646cd9',
  download: { v4: 'd3f86a106a0bac45b974a628896c90dbdf5c8093', v8: '9000827ccba6bdab643e8b6fd33ac0654aef8333' },
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 15000 }).trim();
const write = async (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const exactSHA = (value) => { assert.match(value ?? '', /^[0-9a-f]{40}$/); return value; };
await fs.mkdir(directory, { recursive: true });

function sourceIdentity() {
  const source = exactSHA(process.env.SOURCE_SHA);
  const base = exactSHA(process.env.EXPECTED_BASE);
  const head = exactSHA(process.env.EXPECTED_HEAD);
  assert.equal(git('rev-parse', 'HEAD'), source, 'checkout must match frozen source');
  assert.deepEqual(git('rev-list', '--parents', '-n', '1', source).split(' '), [source, base, head],
    'require exactly the reviewed base and PR head as merge parents');
  git('diff', '--exit-code');
  git('diff', '--cached', '--exit-code');
  return { source, base, head, tree: exactSHA(git('rev-parse', 'HEAD^{tree}')) };
}

const identity = sourceIdentity();
const tag = 'v' + JSON.parse(await fs.readFile('package.json', 'utf8')).version;
assert.match(tag, /^v[0-9][A-Za-z0-9.+-]*$/);
const run = {
  url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  attempt: process.env.GITHUB_RUN_ATTEMPT, job: process.env.GITHUB_JOB,
  workflow_ref: process.env.GITHUB_WORKFLOW_REF, workflow_sha: process.env.GITHUB_WORKFLOW_SHA,
  event_base: process.env.EVENT_BASE_SHA, node: process.version, platform: process.platform,
};
const names = targets.map(target => `qi-agent-${tag}-${target}.tar.gz`);
const expectedFiles = names.flatMap(name => [name, name + '.sha256', name + '.source.json']).sort();
const mode = process.argv[2];

if (mode === 'produce') {
  const outputs = [];
  for (const [index, target] of targets.entries()) {
    const output = path.join(directory, target);
    const payload = path.join(directory, 'payload-' + target);
    await fs.mkdir(output); await fs.mkdir(payload);
    await fs.copyFile('README.md', path.join(payload, 'README.md'));
    await write(path.join(payload, 'transport-source.json'), { ...identity, target, tag, kind: 'non-executable-transport-sample' });
    const name = names[index]; const archive = path.join(output, name);
    execFileSync('tar', ['-czf', archive, '-C', payload, 'README.md', 'transport-source.json'], { timeout: 15000 });
    const digest = sha256(await fs.readFile(archive));
    await fs.writeFile(archive + '.sha256', `${digest}  ${name}\n`);
    await write(archive + '.source.json', { asset: name, sha256: digest, sha: identity.source, tag });
    outputs.push({ target, asset: name, sha256: digest });
  }
  await fs.writeFile(path.join(directory, 'sentinel.txt'), 'Must not match release-*64\n');
  await write(path.join(directory, 'producer.json'), { ...identity, tag, actions, run, archives: outputs,
    not_run: ['release binaries', 'cross-platform runtime', 'attestation', 'publish'] });
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT,
    `source=${identity.source}\nbase=${identity.base}\nhead=${identity.head}\n`);
  console.log(JSON.stringify({ status: 'PASS', mode, ...identity, archives: outputs }));
} else if (mode === 'upload-receipt') {
  const uploads = [...targets, 'ci-evidence'].map((target, index) => {
    const id = process.env['UPLOAD_ID_' + index]; const digest = process.env['UPLOAD_DIGEST_' + index];
    assert.match(id ?? '', /^[1-9][0-9]*$/); assert.match(digest ?? '', /^[0-9a-f]{64}$/);
    return { target, id, digest };
  });
  await write(path.join(directory, 'uploads.json'), { ...identity, run, uploads });
} else if (mode === 'consume') {
  const consumer = process.env.DOWNLOAD_VERSION;
  assert.ok(['v4', 'v8'].includes(consumer), 'explicit supported consumer required');
  const dist = path.join(directory, 'dist');
  const producer = JSON.parse(await fs.readFile(path.join(directory, 'producer', 'producer.json')));
  const uploads = JSON.parse(await fs.readFile(path.join(directory, 'producer', 'uploads.json')));
  for (const key of ['source', 'base', 'head', 'tree']) {
    assert.equal(producer[key], identity[key]); assert.equal(uploads[key], identity[key]);
  }
  assert.equal(producer.tag, tag); assert.deepEqual(producer.actions, actions);
  assert.deepEqual(uploads.uploads.map(x => x.target), [...targets, 'ci-evidence']);
  const single = path.join(directory, 'ci-evidence');
  assert.deepEqual(await fs.readdir(single), ['producer.json'], 'single-file verify evidence retains its filename');
  assert.equal(sha256(await fs.readFile(path.join(single, 'producer.json'))),
    sha256(await fs.readFile(path.join(directory, 'producer', 'producer.json'))));
  assert.deepEqual((await fs.readdir(dist)).sort(), expectedFiles, 'exactly twelve files, flattened, without sentinel');
  const gate = path.join(root, 'maintenance/release-gate.mjs');
  async function runGate(label, input, expectedError) {
    const work = path.join(directory, 'gate-' + label);
    await fs.mkdir(work); await fs.cp(input, path.join(work, 'dist'), { recursive: true });
    const result = spawnSync(process.execPath, [gate, 'assets'], { cwd: work, encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, HOME: directory, QI_SOURCE_SHA: identity.source, QI_AGENT_TAG: tag } });
    assert.ifError(result.error); assert.equal(result.signal, null);
    await fs.writeFile(path.join(directory, label + '.log'), result.stdout + result.stderr);
    if (expectedError) {
      assert.equal(result.status, 1, label + ' must be rejected by the real gate');
      const error = JSON.parse(result.stderr.trim());
      assert.equal(error.status, 'UNKNOWN'); assert.ok(error.reason.startsWith(expectedError), error.reason);
    } else assert.equal(result.status, 0, result.stderr);
    return { label, exit_code: result.status, expected_rejection: Boolean(expectedError), reason: expectedError ?? null };
  }
  const results = [await runGate('valid-flat', dist)];
  for (const [index, name] of names.entries()) {
    const archive = path.join(dist, name);
    const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 15000 }).trim().split('\n');
    assert.deepEqual(members.sort(), ['README.md', 'transport-source.json']);
    const listing = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', timeout: 15000 }).trim().split('\n');
    assert.equal(listing.length, 2); assert.ok(listing.every(line => line.startsWith('-')), 'only regular files permitted');
    const readme = execFileSync('tar', ['-xOzf', archive, 'README.md'], { timeout: 15000 });
    assert.equal(sha256(readme), sha256(await fs.readFile('README.md')));
    const manifest = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'transport-source.json'], { encoding: 'utf8', timeout: 15000 }));
    assert.deepEqual(manifest, { ...identity, target: targets[index], tag, kind: 'non-executable-transport-sample' });
  }
  const cases = [
    ['missing-platform', async d => fs.unlink(path.join(d, names[0])), 'Release archive set is incomplete or unexpected'],
    ['corrupt-archive', async d => fs.appendFile(path.join(d, names[0]), 'corruption'), 'Release checksum mismatch:'],
    ['wrong-source', async d => {
      const p = path.join(d, names[0] + '.source.json'); const x = JSON.parse(await fs.readFile(p));
      x.sha = '0'.repeat(40); await write(p, x);
    }, 'Release source manifest mismatch:'],
  ];
  for (const [label, mutate, error] of cases) {
    const input = path.join(directory, 'negative-' + label); await fs.cp(dist, input, { recursive: true });
    await mutate(input); results.push(await runGate(label, input, error));
  }
  const nested = path.join(directory, 'nested');
  assert.deepEqual((await fs.readdir(nested)).sort(), targets.map(t => 'release-' + t).sort());
  results.push(await runGate('non-flat', nested, 'Release archive set is incomplete or unexpected'));
  const report = { status: 'PASS', ...identity, tag, actions, consumer, run, uploads: uploads.uploads, results,
    archive_members: 'README.md and source manifest, regular files only, exact bytes checked',
    service_digest_policy: consumer === 'v8'
      ? 'download-artifact digest-mismatch:error; valid service downloads only'
      : 'download-artifact v4 native policy; independent ZIP digest verification required',
    not_run: ['service digest corruption injection', 'release binaries', 'cross-platform runtime', 'attestation', 'publish'] };
  await write(path.join(directory, 'acceptance.json'), report); console.log(JSON.stringify(report, null, 2));
} else throw new Error('Expected produce, upload-receipt or consume');
