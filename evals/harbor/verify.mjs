// Runs only inside the separate verifier container, as root. Never in the agent image.
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assessTap } from './grading.mjs';

const logs = '/logs/verifier';
mkdirSync(logs, { recursive: true });
chmodSync(logs, 0o700);
const reward = path.join(logs, 'reward.txt');
writeFileSync(reward, '0\n');
try {
  if (process.getuid?.() !== 0) throw new Error('Verifier must start as root to isolate reward writes');
  const manifest = JSON.parse(readFileSync('/tests/manifest.json', 'utf8'));
  const grade = '/grade';
  rmSync(grade, { recursive: true, force: true });
  cpSync('/tests/workspace', grade, { recursive: true });
  cpSync('/tests/verifier', grade, { recursive: true });
  if (existsSync('/app') && lstatSync('/app').isSymbolicLink()) throw new Error('Symlink artifact root rejected');
  for (const relative of manifest.allowed_files) {
    let candidate = '/app';
    for (const part of relative.split('/')) {
      candidate = path.join(candidate, part);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) throw new Error(`Symlink artifact rejected: ${relative}`);
    }
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`Invalid or oversized artifact: ${relative}`);
    const destination = path.join(grade, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(candidate, destination);
    chmodSync(destination, 0o644);
  }
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...manifest.verify_command.slice(2)], {
    cwd: grade, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    // Submitted code cannot edit the trusted test tree or root-owned reward directory.
    uid: 1000, gid: 1000,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' },
  });
  writeFileSync(path.join(logs, 'test-output.txt'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Acceptance exited with ${result.status ?? result.signal}`);
  const assessment = assessTap(result.stdout ?? '', manifest.acceptance_tests);
  writeFileSync(path.join(logs, 'assessment.json'), `${JSON.stringify(assessment, null, 2)}\n`);
  if (!assessment.passed) throw new Error(`Acceptance incomplete: ${assessment.reason}`);
  writeFileSync(reward, '1\n');
} catch (error) {
  writeFileSync(path.join(logs, 'verification-error.txt'), `${error.message}\n`);
  console.error(error.message);
  process.exitCode = 1;
}
