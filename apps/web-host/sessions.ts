import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { SessionSummary, Workspace, WorkerMessage } from "./types.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { AgentWorker, type DaemonEnvironment } from "./worker.js";

interface SessionEvent {
  type?: string;
  at?: string;
  data?: Record<string, unknown>;
}

interface OpenSession {
  summary: SessionSummary;
  worker: AgentWorker;
}

type WorkerFactory = (workspace: string, sessionPath: string, repositoryRoot: string,
  daemonEnvironment: DaemonEnvironment, presetId?: string) => unknown;

async function describeSession(path: string, workspaceId: string): Promise<SessionSummary | null> {
  let id: string | null = null;
  let name: string | null = null;
  let label: string | null = null;
  let updatedAt: string | null = null;
  let eventCount = 0;
  let messageCount = 0;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as SessionEvent;
        eventCount += 1;
        updatedAt = event.at || updatedAt;
        if (event.type === "session/start") id = String(event.data?.session_id || id || "");
        if (event.type === "session/fork") id = String(event.data?.session_id || id || "");
        if (event.type === "session/name") name = String(event.data?.name || "") || null;
        if (event.type === "session/label") label = String(event.data?.label || "") || null;
        if (event.type === "message") messageCount += 1;
      } catch {
        // A partially written final line does not hide the rest of the catalog.
      }
    }
  } finally {
    input.destroy();
  }
  if (!id) return null;
  return { id, workspaceId, path, name, label, eventCount, messageCount, updatedAt };
}

function defaultSessionName(path: string): string {
  return basename(path, ".jsonl").replace(/^\d{8}T\d{6}-/, "");
}

export class SessionManager {
  readonly workspaces: WorkspaceRegistry;
  readonly repositoryRoot: string;
  readonly daemonEnvironment: DaemonEnvironment;
  readonly workerFactory: WorkerFactory;
  #open = new Map<string, OpenSession>();
  #profiles = new Map<string, string>();
  #profilesLoaded: Promise<void> | null = null;
  #profileWrites = Promise.resolve();

  constructor(workspaces: WorkspaceRegistry, repositoryRoot: string,
    daemonEnvironment: DaemonEnvironment = {},
    workerFactory: WorkerFactory = (workspace, sessionPath, root, environment, presetId) =>
      new AgentWorker(workspace, sessionPath, root, environment, presetId)) {
    this.workspaces = workspaces;
    this.repositoryRoot = repositoryRoot;
    this.daemonEnvironment = daemonEnvironment;
    this.workerFactory = workerFactory;
  }

  private async loadProfiles(): Promise<void> {
    if (!this.#profilesLoaded) {
      this.#profilesLoaded = (async () => {
        try {
          const parsed = JSON.parse(await readFile(
            join(this.workspaces.stateDirectory, "session-profiles.json"), "utf8",
          )) as { profiles?: Record<string, string> };
          for (const [path, presetId] of Object.entries(parsed.profiles || {})) {
            if (typeof presetId !== "string" || presetId.length > 128
              || !/^[a-z0-9][a-z0-9_-]*$/.test(presetId)) {
              throw new Error("Session profile state contains an invalid preset id");
            }
            this.#profiles.set(path, presetId);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      })();
    }
    await this.#profilesLoaded;
  }

  private async saveProfiles(): Promise<void> {
    this.#profileWrites = this.#profileWrites.catch(() => undefined).then(async () => {
      const path = join(this.workspaces.stateDirectory, "session-profiles.json");
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({
        profiles: Object.fromEntries(this.#profiles),
      }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    });
    await this.#profileWrites;
  }

  async list(workspace: Workspace): Promise<SessionSummary[]> {
    await this.loadProfiles();
    const directory = join(workspace.path, ".bb-agent", "sessions");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => describeSession(join(directory, entry.name), workspace.id)));
    return summaries.filter((value): value is SessionSummary => Boolean(value))
      .map((summary) => ({
        ...summary,
        name: summary.name || defaultSessionName(summary.path),
        ...(this.#profiles.has(summary.path)
          ? { presetId: this.#profiles.get(summary.path) } : {}),
      }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async listAll(): Promise<SessionSummary[]> {
    return (await Promise.all(this.workspaces.list().map((workspace) => this.list(workspace)))).flat();
  }

  async listPresets(): Promise<unknown> {
    const active = this.#open.values().next().value as OpenSession | undefined;
    if (active) return active.worker.callDaemon("preset.list");
    const workspace = this.workspaces.list()[0];
    if (!workspace) throw new Error("No workspace is allowlisted");
    const control = this.workerFactory(
      workspace.path,
      join(workspace.path, ".bb-agent", ".preset-discovery"),
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
    presetId?: string): Promise<OpenSession & { snapshot: unknown }> {
    await this.loadProfiles();
    const workspace = this.workspaces.get(workspaceId);
    const directory = join(workspace.path, ".bb-agent", "sessions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
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
    try {
      const ready = await worker.start() as WorkerMessage;
      const id = String(ready.session_id);
      if (name?.trim()) await worker.call("session.rename", { name: name.trim() });
      const snapshot = await worker.call("session.snapshot");
      const summary = await describeSession(path, workspace.id);
      if (!summary) throw new Error("New session did not initialize");
      const open = { summary: { ...summary, id, ...(presetId ? { presetId } : {}) }, worker };
      this.#open.set(id, open);
      worker.once("exit", () => this.#open.delete(id));
      return { ...open, snapshot };
    } catch (error) {
      await worker.close();
      if (presetId) {
        this.#profiles.delete(path);
        await this.saveProfiles();
      }
      throw error;
    }
  }

  async open(id: string): Promise<OpenSession & { snapshot: unknown }> {
    const existing = this.#open.get(id);
    if (existing) return { ...existing, snapshot: await existing.worker.call("session.snapshot") };
    const summary = (await this.listAll()).find((entry) => entry.id === id);
    if (!summary) throw new Error("Session was not found in an allowlisted workspace");
    const workspace = this.workspaces.get(summary.workspaceId);
    const worker = this.workerFactory(workspace.path, summary.path, this.repositoryRoot,
      this.daemonEnvironment, summary.presetId) as AgentWorker;
    try {
      await worker.start();
      const snapshot = await worker.call("session.snapshot");
      // Startup plugins may append metadata while recovering an older
      // session (for example, an automatic title). Return that current
      // metadata instead of the catalog snapshot captured before startup.
      const refreshed = await describeSession(summary.path, summary.workspaceId);
      const open = {
        summary: {
          ...(refreshed || summary),
          ...(summary.presetId ? { presetId: summary.presetId } : {}),
        },
        worker,
      };
      this.#open.set(id, open);
      worker.once("exit", () => this.#open.delete(id));
      return { ...open, snapshot };
    } catch (error) {
      await worker.close();
      throw error;
    }
  }

  async fork(id: string, name?: string): Promise<OpenSession & { snapshot: unknown }> {
    const source = await this.open(id);
    const destination = join(dirname(source.summary.path),
      `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomUUID().slice(0, 8)}.jsonl`);
    const result = await source.worker.call("session.fork", { destination }) as {
      path: string;
      "session-id": string;
    };
    const workspace = this.workspaces.get(source.summary.workspaceId);
    if (source.summary.presetId) {
      this.#profiles.set(result.path, source.summary.presetId);
      await this.saveProfiles();
    }
    const worker = this.workerFactory(workspace.path, result.path, this.repositoryRoot,
      this.daemonEnvironment, source.summary.presetId) as AgentWorker;
    try {
      await worker.start();
      if (name?.trim()) await worker.call("session.rename", { name: name.trim() });
      const snapshot = await worker.call("session.snapshot");
      const summary = await describeSession(result.path, workspace.id);
      if (!summary) throw new Error("Forked session did not initialize");
      const open = { summary: {
        ...summary,
        id: result["session-id"],
        ...(source.summary.presetId ? { presetId: source.summary.presetId } : {}),
      }, worker };
      this.#open.set(open.summary.id, open);
      worker.once("exit", () => this.#open.delete(open.summary.id));
      return { ...open, snapshot };
    } catch (error) {
      await worker.close();
      if (source.summary.presetId) {
        this.#profiles.delete(result.path);
        await this.saveProfiles();
      }
      throw error;
    }
  }

  async worker(id: string): Promise<AgentWorker> {
    const existing = this.#open.get(id);
    return existing?.worker || (await this.open(id)).worker;
  }

  async archive(id: string): Promise<{ archived: boolean }> {
    const open = this.#open.get(id);
    const summary = open?.summary || (await this.listAll()).find((entry) => entry.id === id);
    if (!summary) throw new Error("Session was not found in an allowlisted workspace");
    if (open) {
      await open.worker.close();
      this.#open.delete(id);
    }
    const archiveDirectory = join(dirname(dirname(summary.path)), "archive", "sessions");
    await mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
    await rename(summary.path, join(archiveDirectory, basename(summary.path)));
    if (this.#profiles.delete(summary.path)) await this.saveProfiles();
    return { archived: true };
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#open.values()].map(({ worker }) => worker.close()));
    this.#open.clear();
  }

  async shutdownDaemon(): Promise<void> {
    const worker = this.#open.values().next().value?.worker as AgentWorker | undefined;
    if (!worker) return;
    try {
      await worker.call("daemon.shutdown", {}, 2_000);
    } catch {
      // The isolated daemon may already be stopping.
    }
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const entries = [...this.#open.entries()]
      .filter(([, open]) => open.summary.workspaceId === workspaceId);
    await Promise.allSettled(entries.map(([, open]) => open.worker.close()));
    for (const [id] of entries) this.#open.delete(id);
  }

  async reloadProviderSettings(): Promise<void> {
    await Promise.allSettled([...this.#open.values()].map(({ worker }) =>
      worker.call("provider.settings.reload", {}, 10_000)));
  }
}
