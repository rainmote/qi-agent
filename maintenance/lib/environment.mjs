// Host-only environment receipts. Candidates cannot clear their own quarantine.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../../evals/lib/core.mjs';
import { digest, encode, durableWrite, lockStore } from './store.mjs';
import { immutableImage, resourceLimits } from './execution.mjs';

const defaultDirectory = () => path.join(os.homedir(), '.qi-agent', 'maintenance-environments');
const read = file => fs.readFile(file, 'utf8').then(JSON.parse, e => { if (e.code === 'ENOENT') return null; throw e; });
const ok = r => r.exit_code === 0 && !r.error && !r.signal && !r.timed_out && !r.output_limited;

export async function inspectEnvironment({ image, resources, deadline, directory = defaultDirectory(),
  run = runProcess, reconcile = false, owners = [], failure = null, env = process.env }) {
  immutableImage(image);
  const limits = resourceLimits(resources), probes = [];
  let endpoint, key, lock;
  const record = { started_at: new Date().toISOString(), image, resources: limits, probes, owners, status: 'UNKNOWN' };
  const probe = async argv => {
    const remaining = deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('original deadline exhausted');
    const started_at = new Date().toISOString();
    const result = await run('docker', argv, { timeoutMs: Math.min(5000, remaining), maxOutputBytes: 65536 });
    probes.push({ argv, started_at, ended_at: new Date().toISOString(),
      output_sha256: digest(encode(result)), result });
    if (!ok(result)) throw new Error('bounded Docker probe failed');
    return result.stdout.trim();
  };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  lock = await lockStore(directory, { recover: reconcile });
  try {
    // A failed endpoint lookup conservatively blocks all endpoints on this host.
    const globalFault = await read(path.join(directory, 'unresolved.json'));
    if (globalFault && !reconcile) throw new Error('unresolved endpoint requires explicit reconciliation');
    const context = await probe(['context', 'show']);
    endpoint = env.DOCKER_HOST && !env.DOCKER_CONTEXT ? env.DOCKER_HOST :
      await probe(['context', 'inspect', context, '--format', '{{.Endpoints.docker.Host}}']);
    if (!endpoint || endpoint.length > 4096) throw new Error('invalid engine endpoint');
    key = digest(endpoint);
    record.endpoint = { context, identity: key };
    const faultFile = path.join(directory, 'fault-' + key + '.json');
    const oldFault = await read(faultFile);
    if (oldFault && !reconcile) throw new Error('endpoint quarantined; reconcile owned containers first');
    if (reconcile) {
      const receipts = [...(globalFault?.owners ?? []), ...(oldFault?.owners ?? [])];
      const seen = new Map();
      for (const owner of receipts) {
        if (!/^qi-maint-(?:check-)?[a-f0-9-]{36}$/.test(owner.container ?? '') ||
          !/^[a-f0-9-]{36}$/.test(owner.container_owner ?? '')) throw new Error('unknown container ownership receipt');
        const previous = seen.get(owner.container);
        if (previous && previous !== owner.container_owner) throw new Error('conflicting container owners');
        seen.set(owner.container, owner.container_owner);
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('original deadline exhausted');
        const argv = ['inspect', '--type=container', '--format',
          '{"Id":{{json .Id}},"owner":{{json (index .Config.Labels "qi.maintenance.owner")}},"running":{{json .State.Running}}}', owner.container];
        const started_at = new Date().toISOString();
        const result = await run('docker', argv,
          { timeoutMs: Math.min(5000, remaining), maxOutputBytes: 65536 });
        probes.push({ argv, started_at, ended_at: new Date().toISOString(),
          output_sha256: digest(encode(result)), result });
        if (result.timed_out || result.error || result.signal || result.output_limited) throw new Error('container identity unknown');
        if (result.exit_code !== 0) {
          if (!/No such (object|container)/i.test(result.stderr)) throw new Error('container identity unknown');
        } else {
          const item = JSON.parse(result.stdout);
          if (!/^[a-f0-9]{64}$/.test(item?.Id ?? '') || item.owner !== owner.container_owner ||
              item.running !== false) throw new Error('container identity or execution remains unresolved');
        }
      }
    }
    const version = JSON.parse(await probe(['version', '--format', '{{json .}}']));
    const info = JSON.parse(await probe(['info', '--format',
      '{"ID":{{json .ID}},"KernelVersion":{{json .KernelVersion}},"OperatingSystem":{{json .OperatingSystem}},"Architecture":{{json .Architecture}},"NCPU":{{json .NCPU}},"MemTotal":{{json .MemTotal}}}']));
    const actualImage = JSON.parse(await probe(['image', 'inspect', '--format',
      '{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}}}', image]));
    if (!version.Server?.Version || !info.ID || !info.KernelVersion || !info.OperatingSystem || !actualImage.Id ||
        !(actualImage.Id === image || actualImage.RepoDigests?.includes(image))) throw new Error('incomplete environment identity');
    record.identity = { engine: info.ID, server_version: version.Server.Version, kernel: info.KernelVersion,
      virtualization: info.OperatingSystem, virtualization_version: null, architecture: info.Architecture,
      host_cpu: info.NCPU ?? null, host_memory_bytes: info.MemTotal ?? null, image: actualImage.Id,
      endpoint: key, resources: limits };
    record.fingerprint = digest(encode(record.identity));
    if (failure) throw new Error(failure);
    record.status = 'PASS'; record.ended_at = new Date().toISOString();
    await durableWrite(path.join(directory, 'latest-' + key + '.json'), encode(record));
    if (reconcile) {
      await fs.rm(faultFile, { force: true }); await fs.rm(path.join(directory, 'unresolved.json'), { force: true });
    }
    return record;
  } catch (error) {
    record.reason = error.message; record.ended_at = new Date().toISOString();
    const file = path.join(directory, key ? 'fault-' + key + '.json' : 'unresolved.json');
    const previous = await read(file);
    record.owners = [...(previous?.owners ?? []), ...owners];
    await durableWrite(file, encode(record));
    throw Object.assign(new Error('environment-unavailable: ' + error.message), { receipt: record });
  } finally { await lock.close(); }
}
