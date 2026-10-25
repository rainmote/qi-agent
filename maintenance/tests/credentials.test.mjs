import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { containerCommand } from '../lib/execution.mjs';

test('container execution rejects inherited credentials and network before Docker dispatch', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qi-credentials-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = path.join(root, 'calls.jsonl');
  await fs.writeFile(path.join(root, 'docker'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv[2]==='inspect'){console.error('No such container');process.exit(1);}
`, { mode: 0o700 });
  const previous = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.PATH = root + path.delimiter + process.env.PATH;
  process.env.OPENAI_API_KEY = 'fixture-only';
  try {
    for (const options of [{ envNames: ['OPENAI_API_KEY'] }, { envNames: ['DEEPSEEK_API_KEY'] },
      { envNames: ['QI_AGENT_HOME'] }, { network: true }]) {
      await assert.rejects(containerCommand({ image: 'sha256:' + 'a'.repeat(64), argv: ['env'],
        workspace: root, ...options }), /[Cc]redential.*forbidden|[Nn]etwork.*forbidden/);
    }
    await assert.rejects(fs.stat(calls), { code: 'ENOENT' });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
