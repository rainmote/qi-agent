#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { checkCommit, resolveTag, commitSHA } from './lib/github.mjs';
import { checkAssets } from './lib/assets.mjs';

// Environment values are data, never interpolated into a shell or eval.
const [command = 'ci'] = process.argv.slice(2);
try {
  const repository = process.env.GH_REPO;
  const sha = commitSHA(process.env.QI_SOURCE_SHA);
  if (['ci', 'tag'].includes(command)) {
    if (process.env.QI_AGENT_TAG && await resolveTag({ repository, tag: process.env.QI_AGENT_TAG }) !== sha) throw new Error('Tag moved away from the verified source');
    if (command === 'ci') {
      const result = await checkCommit({ repository, sha });
      if (process.env.QI_GATE_REPORT) await fs.writeFile(process.env.QI_GATE_REPORT, JSON.stringify(result, null, 2) + '\n');
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'PASS') process.exitCode = 1;
    } else console.log(JSON.stringify({ status: 'PASS', sha }));
  } else if (command === 'assets') {
    const result = await checkAssets({ directory: 'dist', tag: process.env.QI_AGENT_TAG, sha });
    await fs.writeFile('dist/SHA256SUMS', result.checksums);
    console.log(JSON.stringify(result, null, 2));
  } else throw new Error('Usage: node maintenance/release-gate.mjs ci|tag|assets');
} catch (error) { console.error(JSON.stringify({ status: 'UNKNOWN', reason: error.message })); process.exitCode = 1; }
