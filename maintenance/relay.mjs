#!/usr/bin/env node
// Runs inside the disconnected worker. No provider credentials are present.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
const [directory, ...argv] = process.argv.slice(2);
let busy = false;
const server = http.createServer(async (req, res) => {
  if (busy || req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(403).end(); return; }
  busy = true;
  const id = randomUUID(), request = path.join(directory, id + '.request.json'), reply = path.join(directory, id + '.response.json');
  try {
    const parts = []; let size = 0;
    for await (const part of req) { size += part.length; if (size > 2 * 1024 * 1024) throw new Error('Request too large'); parts.push(part); }
    const envelope = JSON.stringify({ method: req.method, path: req.url, body: JSON.parse(Buffer.concat(parts).toString()),
      accounting: { logical_request_id: req.headers['x-qi-request-id'], native_run_id: req.headers['x-qi-run-id'], purpose: req.headers['x-qi-purpose'] } });
    await fs.writeFile(request + '.tmp', envelope, { flag: 'wx', mode: 0o600 });
    await fs.rename(request + '.tmp', request);
    const deadline = Date.now() + 190_000;
    let response;
    while (Date.now() < deadline) {
      try { response = JSON.parse(await fs.readFile(reply, 'utf8')); break; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!response) throw new Error('Broker did not settle the request');
    res.writeHead(response.status, { 'content-type': 'application/json' }).end(JSON.stringify(response.body));
    await fs.unlink(reply);
  } catch { if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"message":"Maintenance broker unavailable"}}'); }
  finally { busy = false; }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', env: { ...process.env,
  QI_MAINTENANCE_BROKER_URL: `http://127.0.0.1:${server.address().port}/v1` } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { server.closeAllConnections(); server.close(); process.exitCode = 1; });
child.on('exit', (code) => { server.closeAllConnections(); server.close(); process.exitCode = code ?? 1; });
