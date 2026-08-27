import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
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
  #open = new Map<string, OpenSession>();

  constructor(workspaces: WorkspaceRegistry, repositoryRoot: string,
    daemonEnvironment: DaemonEnvironment = {}) {
    this.workspaces = workspaces;
    this.repositoryRoot = repositoryRoot;
    this.daemonEnvironment = daemonEnvironment;
  }

  async list(workspace: Workspace): Promise<SessionSummary[]> {
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
      .map((summary) => ({ ...summary, name: summary.name || defaultSessionName(summary.path) }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async listAll(): Promise<SessionSummary[]> {
    return (await Promise.all(this.workspaces.list().map((workspace) => this.list(workspace)))).flat();
  }

  async create(workspaceId: string, name?: string): Promise<OpenSession & { snapshot: unknown }> {
    const workspace = this.workspaces.get(workspaceId);
    const directory = join(workspace.path, ".bb-agent", "sessions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const path = join(directory, `${stamp}-${randomUUID().slice(0, 8)}.jsonl`);
    const worker = new AgentWorker(workspace.path, path, this.repositoryRoot,
      this.daemonEnvironment);
    const ready = await worker.start() as WorkerMessage;
    const id = String(ready.session_id);
    if (name?.trim()) await worker.call("session.rename", { name: name.trim() });
    const snapshot = await worker.call("session.snapshot");
    const summary = await describeSession(path, workspace.id);
    if (!summary) throw new Error("New session did not initialize");
    const open = { summary: { ...summary, id }, worker };
    this.#open.set(id, open);
    worker.once("exit", () => this.#open.delete(id));
    return { ...open, snapshot };
  }

  async open(id: string): Promise<OpenSession & { snapshot: unknown }> {
    const existing = this.#open.get(id);
    if (existing) return { ...existing, snapshot: await existing.worker.call("session.snapshot") };
    const summary = (await this.listAll()).find((entry) => entry.id === id);
    if (!summary) throw new Error("Session was not found in an allowlisted workspace");
    const workspace = this.workspaces.get(summary.workspaceId);
    const worker = new AgentWorker(workspace.path, summary.path, this.repositoryRoot,
      this.daemonEnvironment);
    await worker.start();
    const snapshot = await worker.call("session.snapshot");
    const open = { summary, worker };
    this.#open.set(id, open);
    worker.once("exit", () => this.#open.delete(id));
    return { ...open, snapshot };
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
    const worker = new AgentWorker(workspace.path, result.path, this.repositoryRoot,
      this.daemonEnvironment);
    await worker.start();
    if (name?.trim()) await worker.call("session.rename", { name: name.trim() });
    const snapshot = await worker.call("session.snapshot");
    const summary = await describeSession(result.path, workspace.id);
    if (!summary) throw new Error("Forked session did not initialize");
    const open = { summary: { ...summary, id: result["session-id"] }, worker };
    this.#open.set(open.summary.id, open);
    worker.once("exit", () => this.#open.delete(open.summary.id));
    return { ...open, snapshot };
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
