import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { verificationGit } from "../shared/workspace-verification.mjs";
import { ensurePrivateDirectory, writePrivateFileAtomically } from "./storage.js";
import { workspaceId, type WorkspaceRegistry } from "./workspaces.js";

export interface CodingCandidateConfig {
  schema_version: 1; controller_path: string; controller_sha: string;
  directory: string; contracts: Record<string, string>;
}
export interface CandidateWriter { agent_id: string; resident: boolean }
export interface CodingCandidate {
  candidate_id: string; workspace_id: string; command_id: string; base_sha: string;
  intent_sha256: string; controller_sha: string; controller_path: string;
  state_root: string; cwd: string; candidate_workspace_id: string;
  status: "preparing" | "ready" | "unknown" | "closed";
  lease_owner: string; writer_session: string | null; original_dirty: boolean;
  reason?: string;
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const within = (child: string, parent: string) => child === parent || child.startsWith(parent + sep);
const validCommand = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);

async function futureDirectory(path: string): Promise<string> {
  let cursor = resolve(path);
  const tail: string[] = [];
  while (true) {
    try { return join(await realpath(cursor), ...tail); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = resolve(cursor, "..");
      if (parent === cursor) throw error;
      tail.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

async function readJSON(path: string): Promise<any> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 2 * 1024 * 1024) throw new Error("Invalid candidate state or contract");
    const bytes = await handle.readFile();
    const after = await lstat(path);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Candidate state changed while reading");
    return JSON.parse(bytes.toString());
  } finally { await handle.close(); }
}

/** Host-selected contracts and controller only. No browser-selected profile,
 * verifier, command, image, state directory, repository or controller revision. */
export class CodingCandidates {
  readonly config: CodingCandidateConfig;
  private directory = "";
  constructor(config: CodingCandidateConfig, private workspaces: WorkspaceRegistry,
    private writers: (cwd: string) => Promise<CandidateWriter[]>) {
    this.config = structuredClone(config);
  }

  async initialize(): Promise<void> {
    const config = this.config;
    if (config.schema_version !== 1 || !/^[a-f0-9]{40}$/.test(config.controller_sha)
      || ![config.controller_path, config.directory].every(isAbsolute)
      || !config.contracts || typeof config.contracts !== "object" || Array.isArray(config.contracts)) throw new Error("Pin a candidate controller, private directory and contracts");
    config.controller_path = await realpath(config.controller_path);
    this.directory = await futureDirectory(config.directory);
    const roots = [config.controller_path];
    for (const workspace of this.workspaces.list()) {
      if (within(workspace.path, this.directory)) {
        const match = /^(coding-[a-f0-9]{32})\/workspaces\/\1$/.exec(workspace.path.slice(this.directory.length + 1));
        if (match && (await this.read(match[1])).candidate_workspace_id === workspace.id) continue;
      }
      roots.push(workspace.path);
    }
    for (const root of roots) {
      if (within(this.directory, root) || within(root, this.directory)) throw new Error("Candidate state overlaps a workspace or controller");
    }
    await ensurePrivateDirectory(this.directory);
    await this.trusted();
  }

  private async trusted(): Promise<any> {
    const controller = this.config.controller_path;
    if ((await verificationGit(controller, ["rev-parse", "HEAD"])).trim() !== this.config.controller_sha
      || (await verificationGit(controller, ["status", "--porcelain", "--untracked-files=all"])).trim()) throw new Error("Pinned candidate controller changed");
    return { api: await import(pathToFileURL(join(controller, "maintenance/lib/controller.mjs")).href),
      store: await import(pathToFileURL(join(controller, "maintenance/lib/store.mjs")).href),
      policy: JSON.parse(await readFile(join(controller, "maintenance/policy.json"), "utf8")) };
  }

  private async locked<T>(action: () => Promise<T>, recoverDead = false): Promise<T> {
    const file = join(this.directory, "operation.lock");
    if (recoverDead) {
      try {
        const info = await lstat(file), owner = await readJSON(file);
        if (owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error("Unknown candidate lock owner");
        let dead = false;
        try { process.kill(owner.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        if (!dead) throw new Error("Candidate operation owner is still alive; lock retained");
        const after = await lstat(file);
        if (info.ino !== after.ino || info.dev !== after.dev) throw new Error("Candidate lock changed during reconciliation");
        await rm(file);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const token = randomUUID();
    const lock = await open(file, "wx", 0o600).catch(() => { throw new Error("Candidate operation is busy; reconcile before retrying"); });
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), token })); await lock.sync();
      return await action();
    } finally {
      await lock.close();
      if ((await readJSON(file)).token === token) await rm(file);
    }
  }

  private file(id: string): string {
    if (!/^coding-[a-f0-9]{32}$/.test(id)) throw new Error("Invalid candidate identity");
    return join(this.directory, `${id}.json`);
  }
  private async save(record: CodingCandidate): Promise<void> {
    await writePrivateFileAtomically(this.file(record.candidate_id), JSON.stringify(record));
    const directory = await open(this.directory, "r"); try { await directory.sync(); } finally { await directory.close(); }
  }
  private async read(id: string): Promise<CodingCandidate> {
    const record = await readJSON(this.file(id)) as CodingCandidate;
    if (record.candidate_id !== id || record.controller_sha !== this.config.controller_sha
      || record.controller_path !== this.config.controller_path
      || record.state_root !== join(this.directory, id)
      || record.cwd !== join(record.state_root, "workspaces", id)
      || record.candidate_workspace_id !== workspaceId(record.cwd) || record.lease_owner !== id) throw new Error("Candidate state bindings changed");
    this.workspaces.get(record.workspace_id);
    return record;
  }
  private async attach(record: CodingCandidate): Promise<CodingCandidate> {
    if (record.status === "ready") {
      const workspace = await this.workspaces.add(record.cwd);
      if (workspace.id !== record.candidate_workspace_id) throw new Error("Candidate directory changed");
      await writePrivateFileAtomically(join(this.directory, `workspace-${workspace.id}.json`), JSON.stringify({ candidate_id: record.candidate_id }));
    }
    return record;
  }

  async begin(input: Record<string, unknown>): Promise<CodingCandidate> {
    if (Object.keys(input).some(key => !["workspace_id", "base_sha", "command_id"].includes(key))
      || typeof input.workspace_id !== "string" || !validCommand(input.command_id)
      || typeof input.base_sha !== "string" || !/^[a-f0-9]{40}$/.test(input.base_sha)) throw new Error("Explicit workspace_id/base_sha/command_id required");
    const workspace = this.workspaces.get(input.workspace_id);
    const contractFile = this.config.contracts[workspace.id];
    if (!contractFile || !isAbsolute(contractFile) || within(await realpath(contractFile), workspace.path)) throw new Error("No host-selected external contract for this workspace");
    const contract = await readJSON(contractFile);
    if (contract.base_sha !== input.base_sha) throw new Error("Base must match the frozen host contract");
    const id = `coding-${hash(JSON.stringify([workspace.id, input.command_id])).slice(0, 32)}`;
    const intent = hash(JSON.stringify([workspace.id, input.base_sha, input.command_id, contract]));
    return this.locked(async () => {
      const trusted = await this.trusted();
      try {
        const existing = await this.read(id);
        if (existing.intent_sha256 !== intent) throw new Error("Command identity already has different parameters or contract");
        // Never replay a prepare whose response was lost; reconcile it instead.
        return this.attach(existing);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const ownerFile = join(this.directory, `owner-${workspace.id}.json`);
      try {
        const owner = await readJSON(ownerFile), existing = await this.read(owner.candidate_id);
        if (existing.status !== "closed") throw new Error("Source workspace already owns a candidate");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const stateRoot = join(this.directory, id), cwd = join(stateRoot, "workspaces", id);
      const record: CodingCandidate = { candidate_id: id, workspace_id: workspace.id,
        command_id: input.command_id as string, base_sha: input.base_sha as string,
        intent_sha256: intent, controller_sha: this.config.controller_sha, controller_path: this.config.controller_path,
        state_root: stateRoot, cwd, candidate_workspace_id: workspaceId(cwd), status: "preparing",
        lease_owner: id, writer_session: null,
        original_dirty: !!(await verificationGit(workspace.path, ["status", "--porcelain", "--untracked-files=all"])).trim() };
      await this.save(record);
      await writePrivateFileAtomically(ownerFile, JSON.stringify({ candidate_id: id }));
      await mkdir(stateRoot, { mode: 0o700 });
      let lock;
      try {
        lock = await trusted.store.lockStore(stateRoot);
        const result = await trusted.api.prepare({ repo: workspace.path, root: stateRoot,
          controller: this.config.controller_path, task: { ...contract, task_id: id }, policy: trusted.policy, lock });
        if (result.status !== "scoped" || await realpath(result.workspace) !== cwd) throw new Error("Controller did not confirm candidate preparation");
        await this.trusted();
        record.status = "ready";
      } catch (error) {
        record.status = "unknown"; record.reason = error instanceof Error ? error.message : "prepare-unconfirmed";
      } finally { await lock?.close(); }
      await this.save(record);
      return this.attach(record);
    });
  }

  async status(id: string): Promise<CodingCandidate & { writers: CandidateWriter[] | null }> {
    const record = await this.read(id);
    return { ...record, writers: await this.writers(record.cwd).catch(() => null) };
  }

  async reconcile(id: string): Promise<CodingCandidate> {
    return this.locked(async () => {
      const record = await this.read(id), trusted = await this.trusted();
      const { state } = await trusted.api.loadTask(record.state_root, id);
      if (state.workspace !== record.cwd || state.base_sha !== record.base_sha || state.controller_sha !== record.controller_sha) throw new Error("Controller task binding changed");
      if (state.status === "scoped") { record.status = "ready"; delete record.reason; }
      else if (state.status === "cancelled") record.status = "closed";
      else { record.status = "unknown"; record.reason = `controller-${state.status}`; }
      await this.save(record); return this.attach(record);
    }, true);
  }

  async close(id: string): Promise<CodingCandidate> {
    return this.locked(async () => {
      const record = await this.read(id), trusted = await this.trusted();
      if (record.status === "closed") return record;
      const writers = await this.writers(record.cwd);
      if (writers.some(writer => writer.resident)) throw new Error("Candidate writer is still resident; stop and reconcile it before releasing ownership");
      const { state } = await trusted.api.loadTask(record.state_root, id);
      const lock = await trusted.store.lockStore(record.state_root);
      try {
        await trusted.api.transition(record.state_root, lock, id, state.revision, "cancelled", { reason: "explicit-candidate-close" });
      } finally { await lock.close(); }
      record.status = "closed"; await this.save(record); return record;
    });
  }

  async claim(candidateWorkspace: string, sessionId: string): Promise<void> {
    if (!/^[a-f0-9]{16}$/.test(candidateWorkspace)) throw new Error("Invalid workspace identity");
    let owner;
    try { owner = await readJSON(join(this.directory, `workspace-${candidateWorkspace}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    return this.locked(async () => {
      const record = await this.read(owner.candidate_id);
      if (record.candidate_workspace_id !== candidateWorkspace) throw new Error("Candidate workspace binding changed");
      if (record.status !== "ready") throw new Error("Candidate is not writable; reconcile its state");
      if (record.writer_session && record.writer_session !== sessionId) throw new Error("Candidate already belongs to another writer session");
      record.writer_session = sessionId; await this.save(record);
    });
  }
}
