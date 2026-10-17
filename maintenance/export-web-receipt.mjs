import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { verificationGit, verificationKey, workspaceManifest, validateReceiptBindings } from '../apps/shared/workspace-verification.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);

/** Read an existing independent verdict; never run, change, or accept the candidate. */
export async function exportWebReceipt({ root, id, controller, controllerSha, turnId, directory }) {
  if (![root, controller, directory].every(path.isAbsolute) || !/^[a-f0-9]{40}$/.test(controllerSha ?? '')) throw new Error('Pin absolute state/controller/output paths and the reviewed controller SHA');
  controller = await fs.realpath(controller); root = await fs.realpath(root);
  directory = path.resolve(directory);
  assert.equal((await verificationGit(controller, ['rev-parse', 'HEAD'])).trim(), controllerSha, 'Trusted controller revision changed');
  assert.equal((await verificationGit(controller, ['status', '--porcelain', '--untracked-files=all'])).trim(), '', 'Trusted controller must be clean');
  const trusted = await import(pathToFileURL(path.join(controller, 'maintenance/lib/controller.mjs')).href);
  const store = await import(pathToFileURL(path.join(controller, 'maintenance/lib/store.mjs')).href);
  const { state, task } = await trusted.loadTask(root, id);
  assert.equal(state.controller_sha, controllerSha, 'Task was checked by a different controller');
  assert.equal(state.status, 'review_ready', 'No complete independent verdict');
  const workspace = await fs.realpath(state.workspace);
  if (within(root, workspace) || within(controller, workspace) || within(workspace, controller)
      || within(directory, workspace) || within(workspace, directory)) throw new Error('Verifier material/output overlaps the candidate');
  if (within(directory, controller)) throw new Error('Receipt output must be outside the trusted controller');
  assert.equal((await verificationGit(workspace, ['rev-parse', `${state.candidate_sha}^{tree}`])).trim(), state.candidate_tree);
  const required = [...task.checks.map(check => check.id), ...(task.acceptance ? ['acceptance'] : [])];
  const checked = state.checks.filter(check => check.phase === 'candidate');
  assert.equal(checked.length, required.length);
  const checks = [];
  for (const id of required) {
    const matching = checked.filter(check => check.id === id); assert.equal(matching.length, 1);
    const check = matching[0]; assert.equal(check.status, 'PASS'); assert.equal(check.image, task.image);
    const raw = JSON.parse(await store.readArtifact(root, check.output));
    if (raw.exit_code !== 0 || raw.error || raw.signal || raw.timed_out || raw.output_limited
        || /^(?:# |ℹ )(?:skipped|cancelled) [1-9]\d*$/mu.test(raw.stdout ?? '')) throw new Error('Incomplete execution evidence');
    checks.push({ id, status: 'PASS' });
  }
  const format = (await verificationGit(workspace, ['rev-parse', '--show-object-format'])).trim();
  const source = await workspaceManifest(workspace, format);
  const expected = (await verificationGit(workspace, ['ls-tree', '-rz', state.candidate_sha])).split('\0').filter(Boolean).map(line => {
    const [entry, file] = line.split('\t'), [mode, type, object] = entry.split(' ');
    if (type !== 'blob' || !['100644','100755'].includes(mode)) throw new Error('Unsupported verified source entry');
    return { file, mode, object };
  }).sort((a,b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  assert.deepEqual(source.map(({ file, mode, object }) => ({ file, mode, object })), expected, 'Workspace no longer matches the independently verified tree');
  const receipt = { schema_version: 1, status: 'PASS', workspace_path: workspace, turn_id: turnId,
    candidate_sha: state.candidate_sha, created_at: new Date().toISOString(),
    source_files: source.map(({ object, ...file }) => file),
    bindings: { controller_sha: controllerSha, contract_sha256: state.contract_hash,
      material_sha256: state.material_hash, profile_sha256: state.profile_hash, verifier_sha256: state.verifier_hash, image: task.image },
    required_checks: required, checks };
  validateReceiptBindings(receipt, controllerSha);
  // Recheck both source and controller evidence immediately before publishing a receipt.
  assert.deepEqual(await workspaceManifest(workspace, format), source, 'Workspace changed during export');
  const latest = await trusted.loadTask(root, id); assert.deepEqual(latest.state, state, 'Verifier state changed during export');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || await fs.realpath(directory) !== directory) throw new Error('Receipt directory must be private and canonical');
  const file = path.join(directory, verificationKey(workspace, turnId) + '.json');
  const bytes = JSON.stringify(receipt) + '\n';
  // Existing identities are immutable: reconcile instead of replacing a previous export.
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const parent = await fs.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
  return { file, sha256: hash(bytes), candidate_sha: receipt.candidate_sha, status: 'PASS' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = { '--state':'root','--id':'id','--controller':'controller','--controller-sha':'controllerSha','--turn-id':'turnId','--output-directory':'directory' };
  const options = {};
  for (let i=2; i<process.argv.length; i+=2) {
    const key = names[process.argv[i]];
    if (!key || options[key] || !process.argv[i+1]) throw new Error('Expected unique --state/--id/--controller/--controller-sha/--turn-id/--output-directory pairs');
    options[key] = process.argv[i+1];
  }
  if (Object.keys(options).length !== 6) throw new Error('All explicit verifier/export arguments are required');
  console.log(JSON.stringify(await exportWebReceipt(options)));
}
