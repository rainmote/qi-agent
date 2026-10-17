import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// The controlled identity regression predates compaction lifecycle events.
// Keep its known solution independent of future controller/application changes.
export const DEFAULT_COMPACTION_ORACLE = 'a0b74ad310aa0e0978f747369c41315560aa6dd3';
export const COMPACTION_ORACLE_FILES = Object.freeze(['src/qi/generation.clj', 'src/qi/plugins/context_manager.clj']);

export function compactionOracle(repo, sha = DEFAULT_COMPACTION_ORACLE) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Compaction oracle requires an exact commit SHA');
  const type = execFileSync('git', ['-C', repo, 'cat-file', '-t', sha], { encoding: 'utf8' }).trim();
  if (type !== 'commit') throw new Error('Compaction oracle must identify a commit');
  const files = COMPACTION_ORACLE_FILES.map(file => {
    const bytes = execFileSync('git', ['-C', repo, 'show', `${sha}:${file}`], { maxBuffer: 4 * 1024 * 1024 });
    const content = bytes.toString('utf8');
    if (!Buffer.from(content).equals(bytes)) throw new Error('Compaction oracle source must be UTF-8');
    return { file, content, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  return { sha, files };
}

export function compactionOracleDriver(oracle) {
  const payload = oracle.files.map(({ file, content }) => [file, content]);
  return { mode: 'offline', paid: false, unattended: false, argv: ['node', '-e',
    `const fs=require('node:fs'); for(const [file,content] of ${JSON.stringify(payload)}) fs.writeFileSync(file,content);`] };
}
