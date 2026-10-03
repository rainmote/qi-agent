import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { EventReplay, HostEvent, WorkerMessage } from "./types.js";
import { mutation } from "../shared/methods.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  scope: "agent" | "daemon";
  commandId: string | null;
}

export interface DaemonEnvironment {
  runtimeDirectory?: string;
  stateDirectory?: string;
  providerSettingsPath?: string;
  attachmentDirectory?: string;
  clientNamespace?: string;
  idleDetachMs?: number;
}

export class AgentWorker extends EventEmitter {
  readonly workspaceRoot: string;
  readonly sessionPath: string;
  readonly repositoryRoot: string;
  readonly daemonEnvironment: DaemonEnvironment;
  readonly presetId?: string;
  #socket: Socket | null = null;
  #pending = new Map<string, PendingCall>();
  #snapshotTransfers = new Map<string, Array<string | undefined>>();
  #connected: Promise<void> | null = null;
  #ready: Promise<WorkerMessage> | null = null;
  #hostSequence = 0;
  #hostEpoch = randomUUID();
  #daemonGeneration: number | null = null;
  #events: HostEvent[] = [];
  #diagnostics = "";
  #agentId: string | null = null;
  #clientId = `web-${randomUUID()}`;
  #journalId: string;
  #clients = 0;
  #idleTimer: NodeJS.Timeout | null = null;
  #initialSnapshot: { snapshot: unknown; eventCursor: string } | null = null;
  #revoked = false;
  authorize: () => void = () => undefined;
  releaseIdle: () => Promise<void> = async () => undefined;
  #closed = false;
  #retiring = false;
  #closing: Promise<void> | null = null;

  constructor(workspaceRoot: string, sessionPath: string, repositoryRoot: string,
    daemonEnvironment: DaemonEnvironment = {}, presetId?: string) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.sessionPath = sessionPath;
    this.repositoryRoot = repositoryRoot;
    this.daemonEnvironment = daemonEnvironment;
    this.presetId = presetId;
    // Durable command journals are scoped to this host state and session, not
    // the lifetime of one socket. Reconnects can query the original outcome.
    this.#journalId = `web-${createHash("sha256").update(JSON.stringify([
      daemonEnvironment.clientNamespace || daemonEnvironment.stateDirectory || repositoryRoot,
      workspaceRoot, sessionPath,
    ])).digest("hex")}`;
  }

  private assertAuthorized(): void {
    if (this.#revoked) throw new Error("Workspace access was revoked");
    this.authorize();
  }

  revoke(): void { this.#revoked = true; }

  async snapshot(): Promise<{ snapshot: unknown; eventCursor?: string }> {
    await this.start();
    this.assertAuthorized();
    const initial = this.#initialSnapshot;
    this.#initialSnapshot = null;
    if (initial) return snapshotHandoff(initial.snapshot, initial.eventCursor);
    // Capture BEFORE dispatch. Events included in both the snapshot and replay
    // are deduplicated by durable IDs/state revisions in the projection.
    const eventCursor = this.eventCursor;
    return snapshotHandoff(await this.call("session.snapshot"), eventCursor);
  }

  async start(): Promise<WorkerMessage> {
    this.assertAuthorized();
    if (this.#closing) await this.#closing;
    if (this.#retiring) throw new Error("qì agent worker exited; daemon control requests are still completing");
    if (this.#ready) return this.#ready;
    this.#closed = false;
    this.#ready = this.initialize().catch(async (error) => {
      if (!(error instanceof Error) || !/worker quota reached/.test(error.message)) throw error;
      await this.releaseIdle();
      this.assertAuthorized();
      return this.initialize();
    });
    return this.#ready;
  }

  async call(method: string, params: Record<string, unknown> = {},
    timeoutMs = 30_000, commandId?: string): Promise<unknown> {
    await this.start();
    this.assertAuthorized();
    if (mutation(method)) this.#initialSnapshot = null;
    return this.request(method, params, timeoutMs, this.#agentId, commandId);
  }

  async callDaemon(method: string, params: Record<string, unknown> = {},
    timeoutMs = 10_000): Promise<unknown> {
    this.assertAuthorized();
    if (this.#closing) await this.#closing;
    await this.connect();
    return this.request(method, params, timeoutMs, null);
  }

  eventsAfter(sequence = 0): HostEvent[] {
    return this.#events.filter((event) => event.hostSeq > sequence);
  }

  get eventCursor(): string {
    return `${this.#hostEpoch}:${this.#hostSequence}`;
  }

  replayAfter(cursor?: string | null): EventReplay {
    if (!cursor) return { reset: "initial", events: [] };
    const match = /^([^:]+):(\d+)$/.exec(cursor);
    if (!match) return { reset: "invalid-cursor", events: [] };
    if (match[1] !== this.#hostEpoch) return { reset: "generation", events: [] };
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(sequence) || sequence > this.#hostSequence) {
      return { reset: "invalid-cursor", events: [] };
    }
    const earliest = this.#events[0]?.hostSeq ?? this.#hostSequence + 1;
    if (sequence < earliest - 1) return { reset: "buffer-gap", events: [] };
    return { reset: null, events: this.eventsAfter(sequence) };
  }

  subscribeClient(): () => void {
    this.assertAuthorized();
    this.#clients += 1;
    this.cancelIdleDetach();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#clients -= 1;
      this.scheduleIdleDetach();
    };
  }

  get idle(): boolean { return this.#clients === 0 && this.#pending.size === 0; }

  private cancelIdleDetach(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  private scheduleIdleDetach(): void {
    this.cancelIdleDetach();
    if (!this.idle || this.#closed || !this.#socket || this.#closing) return;
    this.#idleTimer = setTimeout(() => {
      if (this.idle) void this.close();
    }, this.daemonEnvironment.idleDetachMs ?? 30_000);
    this.#idleTimer.unref();
  }

  get stderr(): string {
    return this.#diagnostics;
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closing = this.closeConnection();
    try { await this.#closing; }
    finally { this.#closing = null; }
  }

  private async closeConnection(): Promise<void> {
    this.cancelIdleDetach();
    this.#initialSnapshot = null;
    this.#retiring = false;
    const wasClosed = this.#closed;
    this.#closed = true;
    if (!wasClosed) this.emit("exit", { code: null, signal: null });
    if (!this.#socket) return;
    if (this.#agentId) {
      try {
        await this.request("agent.detach", {}, 1_500, this.#agentId);
      } catch {
        // Socket EOF has the same detach semantics.
      }
    }
    this.fail(new Error("qì agent connection detached; pending command outcomes may be uncertain"));
    this.#socket.destroy();
    this.#socket = null;
    this.#connected = null;
    this.#ready = null;
  }

  private async initialize(): Promise<WorkerMessage> {
    await this.connect();
    const agents = await this.request("agent.list", {}, 10_000, null) as Array<{
      agent_id?: string;
      session_path?: string;
      status?: string;
    }>;
    const existing = agents.find((agent) =>
      agent.session_path === this.sessionPath && agent.status !== "stopped");
    let createSnapshot: unknown = null;
    if (existing?.agent_id) {
      this.#agentId = existing.agent_id;
    } else {
      const created = await this.request("agent.create", {
        workspace: this.workspaceRoot,
        session_path: this.sessionPath,
        include_snapshot: false,
        ...(this.presetId ? { preset_id: this.presetId } : {}),
      }, 30_000, null) as {
        agent?: { agent_id?: string };
        snapshot?: unknown;
      };
      this.#agentId = created.agent?.agent_id || null;
      createSnapshot = created.snapshot;
    }
    if (!this.#agentId) throw new Error("qì agent did not return an agent id");
    const eventCursor = this.eventCursor;
    const attached = await this.request("agent.attach", {
      agent_id: this.#agentId,
    }, 30_000, this.#agentId) as {
      snapshot?: { session_id?: string; cursor?: { generation?: number } };
    };
    const snapshot = attached.snapshot || createSnapshot as {
      session_id?: string; cursor?: { generation?: number };
    } | null;
    this.assertAuthorized();
    this.#daemonGeneration ??= snapshot?.cursor?.generation ?? null;
    if (snapshot) this.#initialSnapshot = { snapshot, eventCursor };
    this.scheduleIdleDetach();
    return {
      version: 1,
      type: "ready",
      session_id: snapshot?.session_id,
      agent_id: this.#agentId,
    };
  }

  private async connect(): Promise<void> {
    if (this.#connected) return this.#connected;
    this.#connected = this.initializeConnection();
    try {
      await this.#connected;
    } catch (error) {
      this.#connected = null;
      throw error;
    }
  }

  private async initializeConnection(): Promise<void> {
    const socket = await this.connectOrLaunch();
    this.#socket = socket;
    this.resetEventStream();
    socket.setEncoding("utf8");
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", (line) => { if (this.#socket === socket) this.handleLine(line); });
    socket.on("error", (error) => { if (this.#socket === socket) this.fail(error); });
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.fail(new Error("qì agent daemon connection closed; pending command outcomes may be uncertain"));
      this.#connected = null;
      if (!this.#closed) this.emit("exit", { code: null, signal: null });
    });

    await this.request("daemon.hello", {}, 10_000, null);
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number,
    agentId: string | null, operationId?: string): Promise<unknown> {
    if (method !== "agent.detach") this.assertAuthorized();
    if (!this.#socket || this.#socket.destroyed) {
      return Promise.reject(new Error("qì agent daemon connection is unavailable"));
    }
    const id = `web-request-${randomUUID()}`;
    const commandId = mutation(method) ? operationId || `web-command-${randomUUID()}` : null;
    this.cancelIdleDetach();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(commandError(new Error(`qì agent method timed out: ${method}`), commandId));
        this.scheduleIdleDetach();
        this.closeRetiredConnection();
      }, timeoutMs);
      timer.unref();
      const scope = agentId === null || method.startsWith("daemon.")
        || method === "agent.stop" || method === "session.archive" ? "daemon" : "agent";
      this.#pending.set(id, { resolve, reject, timer, scope, commandId });
      this.#socket!.write(`${JSON.stringify({
        version: 1,
        type: "command",
        request_id: id,
        client_id: this.#clientId,
        journal_id: this.#journalId,
        command_id: commandId,
        agent_id: agentId,
        method,
        params,
      })}\n`);
    });
  }

  private async connectOrLaunch(): Promise<Socket> {
    const socketPath = this.daemonSocketPath();
    try {
      return await connectSocket(socketPath);
    } catch {
      this.launchDaemon();
    }
    const deadline = Date.now() + 20_000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        return await connectSocket(socketPath);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`qì agent daemon did not start: ${String(lastError)}`);
  }

  private daemonSocketPath(): string {
    const runtime = this.daemonEnvironment.runtimeDirectory
      || process.env.QI_AGENT_RUNTIME_DIR
      || process.env.DAO_RUNTIME_DIR
      || (process.env.XDG_RUNTIME_DIR
        ? join(process.env.XDG_RUNTIME_DIR, "qi-agent")
        : join(tmpdir(), `qi-agent-${process.getuid?.() ?? 0}`));
    return join(runtime, "daemon.sock");
  }

  private launchDaemon(): void {
    const release = join(this.repositoryRoot, "apps/tui-rs/target/release/qi-agent");
    const debug = join(this.repositoryRoot, "apps/tui-rs/target/debug/qi-agent");
    const legacyRelease = join(this.repositoryRoot, "apps/tui-rs/target/release/dao");
    const legacyDebug = join(this.repositoryRoot, "apps/tui-rs/target/debug/dao");
    const executable = process.env.QI_AGENT_BIN
      || process.env.DAO_BIN
      || (existsSync(release) ? release
        : existsSync(debug) ? debug
          : existsSync(legacyRelease) ? legacyRelease
            : existsSync(legacyDebug) ? legacyDebug : "qi-agent");
    const child = spawn(executable, [
      "daemon", "serve",
      "--repository-root", this.repositoryRoot,
      "--config", join(this.repositoryRoot, "agent.edn"),
    ], {
      cwd: this.workspaceRoot,
      detached: true,
      env: {
        ...process.env,
        ...(this.daemonEnvironment.attachmentDirectory
          ? { QI_AGENT_ATTACHMENT_DIR: this.daemonEnvironment.attachmentDirectory } : {}),
        ...(this.daemonEnvironment.runtimeDirectory
          ? { QI_AGENT_RUNTIME_DIR: this.daemonEnvironment.runtimeDirectory,
            DAO_RUNTIME_DIR: this.daemonEnvironment.runtimeDirectory } : {}),
        ...(this.daemonEnvironment.stateDirectory
          ? { QI_AGENT_STATE_DIR: this.daemonEnvironment.stateDirectory,
            DAO_STATE_DIR: this.daemonEnvironment.stateDirectory } : {}),
        ...(this.daemonEnvironment.providerSettingsPath
          ? { QI_AGENT_PROVIDER_SETTINGS_FILE: this.daemonEnvironment.providerSettingsPath,
            DAO_PROVIDER_SETTINGS_FILE: this.daemonEnvironment.providerSettingsPath } : {}),
      },
      stdio: "ignore",
    });
    child.on("error", (error) => {
      this.#diagnostics = `${this.#diagnostics}\n${error.message}`.slice(-20_000);
    });
    child.unref();
  }

  private handleLine(line: string): void {
    let message: WorkerMessage;
    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch {
      this.#diagnostics = `${this.#diagnostics}\nInvalid daemon JSON: ${line}`.slice(-20_000);
      return;
    }
    if (message.type === "snapshot.begin") {
      const id = String(message.transfer_id || "");
      this.#snapshotTransfers.set(id, new Array(Number(message.chunks || 0)));
      return;
    }
    if (message.type === "snapshot.chunk") {
      const transfer = this.#snapshotTransfers.get(String(message.transfer_id || ""));
      if (transfer) transfer[Number(message.index || 0)] = String(message.data || "");
      return;
    }
    if (message.type === "snapshot.end") return;
    if (message.type === "response" && message.id) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.ok) {
        try {
          pending.resolve(this.hydrateSnapshot(message.result));
        } catch (error) {
          pending.reject(commandError(error as Error, pending.commandId));
        }
      } else {
        pending.reject(Object.assign(
          new Error(message.error?.message || "qì agent request failed"),
          { data: { ...(message.error?.data as object || {}),
            ...(pending.commandId ? { command_id: pending.commandId } : {}) } }));
      }
      this.scheduleIdleDetach();
      this.closeRetiredConnection();
      return;
    }
    if (message.type === "event" || message.type === "run-result") {
      const cursor = message.cursor as { generation?: unknown } | undefined;
      const generation = typeof cursor?.generation === "number" ? cursor.generation
        : typeof message.generation === "number" ? message.generation : null;
      if (generation !== null && this.#daemonGeneration !== null
        && generation !== this.#daemonGeneration) this.resetEventStream();
      if (generation !== null) this.#daemonGeneration = generation;
      const event = { ...message, hostEpoch: this.#hostEpoch,
        hostSeq: ++this.#hostSequence } as HostEvent;
      this.#events.push(event);
      if (this.#events.length > 2_000) this.#events.splice(0, this.#events.length - 2_000);
      this.emit("event", event);
      if (event.event === "worker/exited") {
        this.#retiring = true;
        this.fail(new Error("qì agent worker exited; pending command outcomes may be uncertain"), true);
        // A normal archive/stop emits worker/exited before its daemon-level
        // response. Retire the stream immediately, but keep that response path.
        if (!this.#closed) {
          this.#closed = true;
          this.emit("exit", { code: null, signal: null });
        }
        this.closeRetiredConnection();
      }
    }
  }

  private resetEventStream(): void {
    this.#hostEpoch = randomUUID();
    this.#hostSequence = 0;
    this.#daemonGeneration = null;
    this.#events = [];
    this.emit("reset");
  }

  private hydrateSnapshot(result: unknown): unknown {
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    const value = result as Record<string, unknown>;
    const transferId = typeof value.snapshot_transfer_id === "string"
      ? value.snapshot_transfer_id : null;
    if (!transferId) return result;
    const chunks = this.#snapshotTransfers.get(transferId);
    this.#snapshotTransfers.delete(transferId);
    if (!chunks || chunks.some((chunk) => chunk === undefined)) {
      throw new Error(`Incomplete qì agent snapshot transfer: ${transferId}`);
    }
    const snapshot = JSON.parse(chunks.join(""));
    if (Object.keys(value).length === 1) return snapshot;
    const hydrated: Record<string, unknown> = { ...value, snapshot };
    delete hydrated.snapshot_transfer_id;
    return hydrated;
  }

  private closeRetiredConnection(): void {
    if (this.#retiring && this.#pending.size === 0) void this.close();
  }

  private fail(error: Error, agentOnly = false): void {
    this.#diagnostics = `${this.#diagnostics}\n${error.message}`.slice(-20_000);
    for (const [id, pending] of this.#pending) {
      if (agentOnly && pending.scope === "daemon") continue;
      clearTimeout(pending.timer);
      pending.reject(commandError(error, pending.commandId));
      this.#pending.delete(id);
    }
    if (!agentOnly) this.#snapshotTransfers.clear();
    this.#initialSnapshot = null;
    if (!this.#closed) this.#ready = null;
  }
}

function snapshotHandoff(snapshot: unknown, eventCursor: string): { snapshot: unknown; eventCursor?: string } {
  const value = snapshot as { state?: { revision?: unknown }; interactions_revision?: unknown };
  const versioned = typeof value?.state?.revision === "number" && typeof value?.interactions_revision === "number";
  // Legacy snapshots cannot discard overlapping transient state safely. Let
  // the SSE recovery path fetch a fresh snapshot and expose its warning.
  return { snapshot, ...(versioned ? { eventCursor } : {}) };
}

function commandError(error: Error, commandId: string | null): Error {
  return commandId ? Object.assign(new Error(error.message), {
    data: { status: "uncertain", command_id: commandId },
  }) : error;
}

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const onError = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}
