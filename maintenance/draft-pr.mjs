#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { lockStore, encode } from './lib/store.mjs';
import { draftPlan, recordDraft } from './lib/draft-pr.mjs';
let lock;
try {
  const { values: args, positionals: [command] } = parseArgs({ allowPositionals: true, options: Object.fromEntries(['state','id','repository','receipt'].map(key => [key,{type:'string'}])) });
  if (!['plan','record'].includes(command) || !path.isAbsolute(args.state ?? '')) throw new Error('Usage: draft-pr.mjs plan|record --state ABS --id ID [--repository OWNER/REPO | --receipt CONNECTOR_RECEIPT.json]');
  lock = await lockStore(args.state);
  console.log(encode(command === 'plan' ? await draftPlan({ root: args.state, id: args.id, lock, repository: args.repository })
    : await recordDraft({ root: args.state, id: args.id, lock, receipt: JSON.parse(await fs.readFile(args.receipt,'utf8')) })));
} catch (error) { console.error(encode({status:'blocked',reason:error.message})); process.exitCode=1; }
finally { if (lock) await lock.close(); }
