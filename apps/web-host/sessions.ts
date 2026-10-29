import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ProviderReloadResult, SessionSummary, Workspace, WorkerMessage } from "./types.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { AgentWorker, type DaemonEnvironment } from "./worker.js";
import { ensurePrivateDirectory, writePrivateFileAtomically } from "./storage.js";
import { SessionCatalog } from "./session-catalog.js";

interface OpenSession {
  summary: SessionSummary;
  worker: AgentWorker;
}

type ArchiveTarget = Pick<SessionSummary, "id" | "workspaceId" | "path">;

type WorkerFactory = (workspace: string, sessionPath: string, repositoryRoot: string,
  daemonEnvironment: DaemonEnvironment, presetId?: string) => unknown;

function defaultSessionName(path: string): string {
  return basename(path, ".jsonl").replace(/^\d{8}T\d{6}-/, "");
}

async function existingPathInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertRealArchiveDirectory(path: string): Promise<void> {
  const info = await existingPathInfo(path);
  if (info && (!info.isDirectory() || await realpath(path) !== path)) {
    throw new Error("Session archive directory must be a real allowlisted directory");
  }
}

export class SessionManager {
  readonly workspaces: WorkspaceRegistry;
  readonly repositoryRoot: string;
  readonly daemonEnvironment: DaemonEnvironment;
  readonly workerFactory: WorkerFactory;
  readonly catalog = new SessionCatalog();
  #closed = false;
  #unsubscribeWorkspace: () => void;
  #open = new Map<string, OpenSession>();
  #workspaceEpochs = new Map<string, number>();
  #starting = new Map<AgentWorker, string>();
  #sessionOperations = new Map<string, Promise<unknown>>();
  #archiveTargets = new Map<string, ArchiveTarget>();
  #archiveTargetsLoaded: Promise<void> | null = null;
  #archiveTargetWrites = Promise.resolve();
  #daemonWorkspace: Workspace | null = null;
  #profiles = new Map<string, string>();
  #profilesLoaded: Promise<void> | null = null;
  #profileWrites = Promise.resolve();

  constructor(workspaces: WorkspaceRegistry, repositoryRoot: string,
    daemonEnvironment: DaemonEnvironment = {},
    workerFactory: WorkerFactory = (workspace, sessionPath, root, environment, presetId) =>
      new AgentWorker(workspace, sessionPath, root, environment, presetId)) {
    this.workspaces = workspaces;
    this.repositoryRoot = repositoryRoot;
    this.daemonEnvironment = { ...daemonEnvironment, clientNamespace: workspaces.stateDirectory };
    this.workerFactory = workerFactory;
    this.#unsubscribeWorkspace = workspaces.onRevoke((id) => this.closeWorkspace(id));
  }

  private lease(id: string): () => void {
    if (this.#closed) throw new Error("Session manager is closed");
    const validate = this.workspaces.lease(id);
    const epoch = this.#workspaceEpochs.get(id) || 0;
    return () => {
      if (this.#closed) throw new Error("Session manager is closed");
      validate();
      if ((this.#workspaceEpochs.get(id) || 0) !== epoch) throw new Error("Workspace access was revoked");
    };
  }

  private prepare(worker: AgentWorker, workspace: Workspace, valid: () => void): void {
    valid();
    worker.authorize = valid;
    worker.releaseIdle = async () => {
      const unused = [...this.#open.values()].filter((entry) => entry.worker !== worker && entry.worker.idle);
      await Promise.allSettled(unused.map((entry) => entry.worker.close()));
    };
    this.#starting.set(worker, workspace.id);
  }

  private async snapshot(worker: AgentWorker): Promise<{ snapshot: unknown; eventCursor?: string }> {
    return typeof worker.snapshot === "function" ? worker.snapshot()
      : { snapshot: await worker.call("session.snapshot") };
  }

  private async loadProfiles(): Promise<void> {
    if (!this.#profilesLoaded) {
      this.#profilesLoaded = (async () => {
        const loaded = new Map<string, string>();
        try {
          const parsed = JSON.parse(await readFile(
            join(this.workspaces.stateDirectory, "session-profiles.json"), "utf8",
          )) as { profiles?: Record<string, string> };
          for (const [path, presetId] of Object.entries(parsed.profiles || {})) {
            if (typeof presetId !== "string" || presetId.length > 128
              || !/^[a-z0-9][a-z0-9_-]*$/.test(presetId)) {
              throw new Error("Session profile state contains an invalid preset id");
            }
            loaded.set(path, presetId);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.#profiles = loaded;
      })().catch((error) => {
        this.#profilesLoaded = null;
        throw error;
      });
    }
    await this.#profilesLoaded;
  }

  private async saveProfiles(): Promise<void> {
    this.#profileWrites = this.#profileWrites.catch(() => undefined).then(async () => {
      const path = join(this.workspaces.stateDirectory, "session-profiles.json");
      await writePrivateFileAtomically(path, `${JSON.stringify({
        profiles: Object.fromEntries(this.#profiles),
      }, null, 2)}\n`);
    });
    await this.#profileWrites;
  }

  private async loadArchiveTargets(): Promise<void> {
    if (!this.#archiveTargetsLoaded) {
      this.#archiveTargetsLoaded = (async () => {
        const loaded = new Map<string, ArchiveTarget>();
        try {
          const parsed = JSON.parse(await readFile(
            join(this.workspaces.stateDirectory, "session-archive-targets.json"), "utf8",
          )) as { targets?: Record<string, Omit<ArchiveTarget, "id">> };
          for (const [id, target] of Object.entries(parsed.targets || {})) {
            if (!target || typeof target.workspaceId !== "string" || typeof target.path !== "string") {
              throw new Error("Session archive state contains an invalid target");
            }
            loaded.set(id, { id, workspaceId: target.workspaceId, path: target.path });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        this.#archiveTargets = loaded;
      })().catch((error) => {
        this.#archiveTargetsLoaded = null;
        throw error;
      });
    }
    await this.#archiveTargetsLoaded;
  }

  private async saveArchiveTargets(): Promise<void> {
    this.#archiveTargetWrites = this.#archiveTargetWrites.catch(() => undefined).then(async () => {
      await writePrivateFileAtomically(
        join(this.workspaces.stateDirectory, "session-archive-targets.json"),
        `${JSON.stringify({ targets: Object.fromEntries([...this.#archiveTargets]
          .map(([id, target]) => [id, { workspaceId: target.workspaceId, path: target.path }])) }, null, 2)}\n`,
      );
    });
    await this.#archiveTargetWrites;
  }

  async list(workspace: Workspace): Promise<SessionSummary[]> {
    await this.loadProfiles();
    return (await this.catalog.list(workspace))
      .map((summary) => this.withProfile(summary))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  private withProfile(summary: SessionSummary): SessionSummary {
    return {
      ...summary,
      name: summary.name || defaultSessionName(summary.path),
      ...(this.#profiles.has(summary.path) ? { presetId: this.#profiles.get(summary.path) } : {}),
    };
  }

  private async find(id: string): Promise<SessionSummary | null> {
    await this.loadProfiles();
    const summary = await this.catalog.find(id, this.workspaces.list());
    return summary ? this.withProfile(summary) : null;
  }

  private withSessionOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionOperations.get(id) || Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.#sessionOperations.set(id, next);
    void next.finally(() => {
      if (this.#sessionOperations.get(id) === next) this.#sessionOperations.delete(id);
    }).catch(() => undefined);
    return next;
  }

  private track(open: OpenSession): void {
    const id = open.summary.id;
    open.worker.authorize?.();
    this.#starting.delete(open.worker);
    this.#open.set(id, open);
    open.worker.once("exit", () => {
      if (this.#open.get(id)?.worker === open.worker) this.#open.delete(id);
    });
  }

  async listAll(): Promise<SessionSummary[]> {
    return (await Promise.all(this.workspaces.list().map((workspace) => this.list(workspace)))).flat();
  }

  async candidateWriters(cwd: string): Promise<Array<{ agent_id: string; resident: boolean }>> {
    this.#daemonWorkspace = this.workspaces.list().find(workspace => workspace.path === cwd) || null;
    const control = this.workerFactory(cwd, join(cwd, ".qi-agent", ".candidate-discovery"),
      this.repositoryRoot, this.daemonEnvironment) as AgentWorker;
    try {
      const agents = await control.callDaemon("agent.list") as Array<{ agent_id: string; workspace_path: string; is_child?: boolean; residency?: string; status?: string }>;
      return agents.filter(agent => !agent.is_child && agent.workspace_path === cwd).map(agent => {
        if (!agent.residency || !["resident", "inactive", "stopped"].includes(agent.residency)) throw new Error("Writer residency is unknown");
        return { agent_id: agent.agent_id, resident: agent.residency === "resident" };
      });
    } finally { await control.close(); }
  }

  async listPresets(): Promise<unknown> {
    const active = this.#open.values().next().value as OpenSession | undefined;
    if (active) return active.worker.callDaemon("preset.list");
    const workspace = this.workspaces.list()[0];
    if (!workspace) throw new Error("No workspace is allowlisted");
    this.#daemonWorkspace = workspace;
    const control = this.workerFactory(
      workspace.path,
      join(workspace.path, ".qi-agent", ".preset-discovery"),
      this.repositoryRoot,
      this.daemonEnvironment,
    ) as AgentWorker;
    try {
      return await control.callDaemon("preset.list");
    } finally {
      await control.close();
    }
  }

  async create(workspaceId: string, name?: string,
    presetId?: string): Promise<OpenSession & { snapshot: unknown; eventCursor?: string }> {
    await this.loadProfiles();
    const workspace = this.workspaces.get(workspaceId);
    const valid = this.lease(workspaceId);
    const directory = join(workspace.path, ".qi-agent", "sessions");
    await ensurePrivateDirectory(directory);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const path = join(directory, `${stamp}-${randomUUID().slice(0, 8)}.jsonl`);
    if (presetId) {
      this.#profiles.set(path, presetId);
      try {
        await this.saveProfiles();
      } catch (error) {
        this.#profiles.delete(path);
        throw error;
      }
    }
    const worker = this.workerFactory(workspace.path, path, this.repositoryRoot,
      this.daemonEnvironment, presetId) as AgentWorker;
    this.#daemonWorkspace = workspace;
    try {
      this.prepare(worker, workspace, valid);
      const ready = await worker.start() as WorkerMessage;
      valid();
      const id = String(ready.session_id);
      if (name?.trim()) await worker.call("session.rename", { name: name.trim() });
      const snapshot = await this.snapshot(worker);
      const summary = await this.catalog.describe(path, workspace.id);
      if (!summary) throw new Error("New session did not initialize");
      const open = { summary: { ...summary, id, ...(presetId ? { presetId } : {}) }, worker };
      valid();
      this.track(open);
      return { ...open, ...snapshot };
    } catch (error) {
      this.#starting.delete(worker);
      await worker.close();
      if (presetId) {
        this.#profiles.delete(path);
        await this.saveProfiles();
      }
      throw error;
    }
  }

  async open(id: string): Promise<OpenSession & { snapshot: unknown; eventCursor?: string }> {
    return this.withSessionOperation(id, () => this.openUnlocked(id));
  }

  private async openUnlocked(id: string): Promise<OpenSession & { snapshot: unknown; eventCursor?: string }> {
    const existing = this.#open.get(id);
    if (existing) {
      this.workspaces.get(existing.summary.workspaceId);
      existing.worker.authorize?.();
      const snapshot = await this.snapshot(existing.worker);
      // A resident worker can append a title or label after it was opened.
      // Reloading the Web client must not restore its creation-time metadata.
      const refreshed = await this.catalog.describe(existing.summary.path, existing.summary.workspaceId);
      existing.worker.authorize?.();
      if (refreshed) {
        if (refreshed.id !== existing.summary.id) throw new Error("Session transcript identity changed");
        existing.summary = {
          ...refreshed,
          ...(existing.summary.presetId ? { presetId: existing.summary.presetId } : {}),
        };
      }
      return { ...existing, ...snapshot };
    }
    const summary = await this.find(id);
    if (!summary) throw new Error("Session was not found in an allowlisted workspace");
    const workspace = this.workspaces.get(summary.workspaceId);
    const valid = this.lease(workspace.id);
    const worker = this.workerFactory(workspace.path, summary.path, this.repositoryRoot,
      this.daemonEnvironment, summary.presetId) as AgentWorker;
    this.#daemonWorkspace = workspace;
    try {
      this.prepare(worker, workspace, valid);
      await worker.start();
      valid();
      const snapshot = await this.snapshot(worker);
      // Startup plugins may append metadata while recovering an older
      // session (for example, an automatic title). Return that current
      // metadata instead of the catalog snapshot captured before startup.
      const refreshed = await this.catalog.describe(summary.path, summary.workspaceId);
      const open = {
        summary: {
          ...(refreshed || summary),
          ...(summary.presetId ? { presetId: summary.presetId } : {}),
        },
        worker,
      };
      valid();
      this.track(open);
      return { ...open, ...snapshot };
    } catch (error) {
      this.#starting.delete(worker);
      await worker.close();
      throw error;
    }
  }

  async fork(id: string, name?: string): Promise<OpenSession & { snapshot: unknown; eventCursor?: string }> {
    const source = await this.open(id);
    const valid = this.lease(source.summary.workspaceId);
    const destination = join(dirname(source.summary.path),
      `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}.jsonl`);
    const result = await source.worker.call("session.fork", { destination }) as {
      path: string;
      "session-id": string;
    };
    valid();
    const workspace = this.workspaces.get(source.summary.workspaceId);
    if (source.summary.presetId) {
      this.#profiles.set(result.path, source.summary.presetId);
      await this.saveProfiles();
    }
    const worker = this.workerFactory(workspace.path, result.path, this.repositoryRoot,
      this.daemonEnvironment, source.summary.presetId) as AgentWorker;
    this.#daemonWorkspace = workspace;
    try {
      this.prepare(worker, workspace, valid);
      await worker.start();
      valid();
      if (name?.trim()) await worker.call("session.rename", { name: name.trim() });
      const snapshot = await this.snapshot(worker);
      const summary = await this.catalog.describe(result.path, workspace.id);
      if (!summary) throw new Error("Forked session did not initialize");
      const open = { summary: {
        ...summary,
        id: result["session-id"],
        ...(source.summary.presetId ? { presetId: source.summary.presetId } : {}),
      }, worker };
      valid();
      this.track(open);
      return { ...open, ...snapshot };
    } catch (error) {
      this.#starting.delete(worker);
      await worker.close();
      if (source.summary.presetId) {
        this.#profiles.delete(result.path);
        await this.saveProfiles();
      }
      throw error;
    }
  }

  async worker(id: string): Promise<AgentWorker> {
    return this.withSessionOperation(id, async () => {
      const existing = this.#open.get(id);
      if (!existing) return (await this.openUnlocked(id)).worker;
      this.workspaces.get(existing.summary.workspaceId);
      existing.worker.authorize?.();
      return existing.worker;
    });
  }

  async commandStatus(id: string, commandId: string): Promise<unknown> {
    const summary = this.#open.get(id)?.summary || await this.find(id);
    if (!summary) throw new Error("Session was not found in an allowlisted workspace");
    const workspace = this.workspaces.get(summary.workspaceId);
    const valid = this.lease(workspace.id);
    const control = this.workerFactory(workspace.path, summary.path, this.repositoryRoot,
      this.daemonEnvironment, summary.presetId) as AgentWorker;
    control.authorize = valid;
    try { return await control.callDaemon("command.status", { command_id: commandId }); }
    finally { await control.close(); }
  }

  async archive(id: string): Promise<{ archived: boolean }> {
    return this.withSessionOperation(id, () => this.archiveUnlocked(id));
  }

  private async archiveUnlocked(id: string): Promise<{ archived: boolean }> {
    await Promise.all([this.loadProfiles(), this.loadArchiveTargets()]);
    const open = this.#open.get(id);
    const summary = this.#archiveTargets.get(id) || open?.summary || await this.find(id);
    if (!summary) throw new Error("Session was not found in an allowlisted workspace");
    const workspace = this.workspaces.get(summary.workspaceId);
    const valid = this.lease(workspace.id);
    if (![".qi-agent", ".bb-agent"].some((root) =>
      dirname(summary.path) === join(workspace.path, root, "sessions"))
      || !summary.path.endsWith(".jsonl")) {
      throw new Error("Session archive source is outside the allowlisted session directories");
    }
    const archiveDirectory = join(dirname(dirname(summary.path)), "archive", "sessions");
    const archivePath = join(archiveDirectory, basename(summary.path));
    await Promise.all([
      assertRealArchiveDirectory(dirname(dirname(summary.path))),
      assertRealArchiveDirectory(dirname(summary.path)),
      assertRealArchiveDirectory(dirname(archiveDirectory)),
      assertRealArchiveDirectory(archiveDirectory),
    ]);
    const sourceInfo = await existingPathInfo(summary.path);
    if (sourceInfo) {
      if (!sourceInfo.isFile() || await realpath(summary.path) !== summary.path) {
        throw new Error("Session archive source must be a real allowlisted file");
      }
      const current = await this.catalog.describe(summary.path, summary.workspaceId);
      if (!current || current.id !== id) {
        throw new Error("Session archive source was replaced by a different or invalid session");
      }
    }
    const destinationInfo = await existingPathInfo(archivePath);
    if (destinationInfo && (!destinationInfo.isFile() || await realpath(archivePath) !== archivePath)) {
      throw new Error("Session archive destination must be a real allowlisted file");
    }
    const presetId = this.#profiles.get(summary.path);
    if (presetId && this.#profiles.get(archivePath) !== presetId) {
      const previous = this.#profiles.get(archivePath);
      if (previous) throw new Error("Session archive destination already has a different profile");
      this.#profiles.set(archivePath, presetId);
      try {
        // Keep both keys until the daemon confirms completion. If the host
        // exits or the response is lost, either transcript location retains
        // its preset; no profile write can strand an already moved transcript.
        await this.saveProfiles();
      } catch (error) {
        if (previous) this.#profiles.set(archivePath, previous);
        else this.#profiles.delete(archivePath);
        throw error;
      }
    }
    if (!this.#archiveTargets.has(id)) {
      this.#archiveTargets.set(id, { id, workspaceId: summary.workspaceId, path: summary.path });
      try {
        // This stores retry identity only. The daemon remains the authority
        // for archived state, writer shutdown and recovering the file move.
        await this.saveArchiveTargets();
      } catch (error) {
        this.#archiveTargets.delete(id);
        throw error;
      }
    }
    const control = open?.worker || this.workerFactory(workspace.path, summary.path,
      this.repositoryRoot, this.daemonEnvironment, presetId) as AgentWorker;
    control.authorize = valid;
    this.#daemonWorkspace = workspace;
    try {
      const result = await control.callDaemon("session.archive", {
        session_path: summary.path, archive_path: archivePath,
      }, 30_000) as { archived?: boolean; session_path?: string };
      if (result.archived !== true || result.session_path !== archivePath) {
        throw new Error("Daemon did not confirm the session archive destination");
      }
      this.catalog.invalidate(summary.path);
      if (open) {
        this.#open.delete(id);
        await open.worker.close();
      }
      if (this.#profiles.delete(summary.path)) {
        try {
          await this.saveProfiles();
        } catch {
          // The preflight write already durably saved both keys. Retaining a
          // redundant old-path key is safe; reporting archive failure here
          // would misleadingly imply the daemon had not stopped/moved it.
          if (presetId) this.#profiles.set(summary.path, presetId);
        }
      }
      return { archived: true };
    } finally {
      // callDaemon deliberately skips start(): archiving a historical file
      // must not create a worker or append startup events to its transcript.
      if (!open) await control.close();
    }
  }

  async closeAll(): Promise<void> {
    this.#closed = true;
    this.#unsubscribeWorkspace();
    const workers = new Set([...this.#open.values()].map(({ worker }) => worker));
    for (const worker of this.#starting.keys()) workers.add(worker);
    for (const worker of workers) worker.revoke?.();
    await Promise.allSettled([...workers].map((worker) => worker.close()));
    this.#open.clear();
    this.#starting.clear();
  }

  async shutdownDaemon(): Promise<void> {
    const active = this.#open.values().next().value?.worker as AgentWorker | undefined;
    const workspace = this.#daemonWorkspace;
    if (!active && !workspace) return;
    const worker = active || this.workerFactory(workspace!.path,
      join(workspace!.path, ".qi-agent", ".daemon-control"),
      this.repositoryRoot, this.daemonEnvironment) as AgentWorker;
    try {
      // The final session may already be archived or detached. Shutdown is
      // daemon-level control and must never hydrate that session to work.
      await worker.callDaemon("daemon.shutdown", {}, 2_000);
    } catch {
      // The isolated daemon may already be stopping.
    } finally {
      if (!active) await worker.close();
      this.#daemonWorkspace = null;
    }
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    this.#workspaceEpochs.set(workspaceId, (this.#workspaceEpochs.get(workspaceId) || 0) + 1);
    const entries = [...this.#open.entries()]
      .filter(([, open]) => open.summary.workspaceId === workspaceId);
    const workers = new Set([...entries.map(([, open]) => open.worker),
      ...[...this.#starting].filter(([, id]) => id === workspaceId).map(([worker]) => worker)]);
    for (const [id] of entries) this.#open.delete(id);
    for (const worker of workers) {
      worker.revoke?.();
      this.#starting.delete(worker);
    }
    await Promise.allSettled([...workers].map((worker) => worker.close()));
  }

  async reloadProviderSettings(sessionIds?: readonly string[]): Promise<ProviderReloadResult> {
    const selected = sessionIds ? new Set(sessionIds) : null;
    const entries = [...this.#open.values()].filter(({ summary }) => !selected || selected.has(summary.id));
    const results = await Promise.allSettled(entries.map(({ worker }) =>
      worker.call("provider.settings.reload", {}, 10_000)));
    const report: ProviderReloadResult = { scope: "open-web-sessions", applied: [], failures: [] };
    results.forEach((result, index) => {
      const session = entries[index].summary;
      if (result.status === "fulfilled") {
        report.applied.push(session.id);
        const warnings = (result.value as { warnings?: unknown } | null)?.warnings;
        if (Array.isArray(warnings)) for (const message of warnings) {
          if (typeof message === "string") (report.warnings ||= []).push({
            sessionId: session.id, sessionName: session.name || session.id, message,
          });
        }
      }
      else report.failures.push({ sessionId: session.id, sessionName: session.name || session.id,
        message: result.reason instanceof Error ? result.reason.message : "会话配置加载失败" });
    });
    // Do not silently report a closed/missing requested session as updated.
    if (selected) for (const id of selected) {
      if (!entries.some(({ summary }) => summary.id === id)) report.failures.push({
        sessionId: id, sessionName: id, message: "会话已断开，请重新打开后重试", });
    }
    return report;
  }
}
