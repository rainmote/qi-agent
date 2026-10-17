import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { HostEvent, WorkerMessage } from "./types.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DaemonEnvironment {
  runtimeDirectory?: string;
  stateDirectory?: string;
}

const mutationMethods = new Set([
  "agent.create", "agent.rename", "agent.stop", "agent.take_control",
  "prompt.submit", "prompt.steer", "prompt.follow_up", "turn.submit", "turn.steer",
  "turn.follow-up", "turn.abort", "run.abort", "session.rename", "session.clear",
  "session.fork", "session.compact", "interaction.resolve", "ui.prompt.resolve",
  "ui.shortcut.invoke", "model.select", "command.execute", "repl.eval",
  "repl.interrupt", "repl.reset", "state.put", "state.delete", "agent.message.send",
  "subagent.stop", "subagent.delete", "schedule.add", "schedule.cancel", "goal.set",
  "goal.cancel", "goal.complete", "goal.resume", "daemon.update", "daemon.backup",
  "daemon.shutdown",
]);

export class AgentWorker extends EventEmitter {
  readonly workspaceRoot: string;
  readonly sessionPath: string;
  readonly repositoryRoot: string;
  readonly daemonEnvironment: DaemonEnvironment;
  #socket: Socket | null = null;
  #pending = new Map<string, PendingCall>();
  #snapshotTransfers = new Map<string, Array<string | undefined>>();
  #ready: Promise<WorkerMessage> | null = null;
  #hostSequence = 0;
  #events: HostEvent[] = [];
  #diagnostics = "";
  #agentId: string | null = null;
  #clientId = `web-${randomUUID()}`;
  #closed = false;

  constructor(workspaceRoot: string, sessionPath: string, repositoryRoot: string,
    daemonEnvironment: DaemonEnvironment = {}) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.sessionPath = sessionPath;
    this.repositoryRoot = repositoryRoot;
    this.daemonEnvironment = daemonEnvironment;
  }

  async start(): Promise<WorkerMessage> {
    if (this.#ready) return this.#ready;
    this.#closed = false;
    this.#ready = this.initialize();
    return this.#ready;
  }

  async call(method: string, params: Record<string, unknown> = {},
    timeoutMs = 30_000): Promise<unknown> {
    await this.start();
    return this.request(method, params, timeoutMs, this.#agentId);
  }

  eventsAfter(sequence = 0): HostEvent[] {
    return this.#events.filter((event) => event.hostSeq > sequence);
  }

  subscribeClient(): () => void {
    // Browser subscriptions are observers. Losing the last one must not deny
    // approvals or abort daemon-owned work.
    return () => undefined;
  }

  get stderr(): string {
    return this.#diagnostics;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (!this.#socket) return;
    try {
      await this.request("agent.detach", {}, 1_500, this.#agentId);
    } catch {
      // Socket EOF has the same detach semantics.
    }
    this.#socket.destroy();
    this.#socket = null;
    this.#ready = null;
  }

  private async initialize(): Promise<WorkerMessage> {
    this.#socket = await this.connectOrLaunch();
    this.#socket.setEncoding("utf8");
    const lines = createInterface({ input: this.#socket, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    // readline forwards input errors separately from the socket error listener.
    lines.on("error", (error) => this.fail(error));
    this.#socket.on("error", (error) => this.fail(error));
    this.#socket.on("close", () => {
      this.fail(new Error("DAO daemon connection closed"));
      if (!this.#closed) this.emit("exit", { code: null, signal: null });
    });

    await this.request("daemon.hello", {}, 10_000, null);
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
      }, 30_000, null) as {
        agent?: { agent_id?: string };
        snapshot?: unknown;
      };
      this.#agentId = created.agent?.agent_id || null;
      createSnapshot = created.snapshot;
    }
    if (!this.#agentId) throw new Error("DAO did not return an agent id");
    const attached = await this.request("agent.attach", {
      agent_id: this.#agentId,
    }, 30_000, this.#agentId) as {
      snapshot?: { session_id?: string };
    };
    const snapshot = attached.snapshot || createSnapshot as { session_id?: string } | null;
    return {
      version: 1,
      type: "ready",
      session_id: snapshot?.session_id,
      agent_id: this.#agentId,
    };
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number,
    agentId: string | null): Promise<unknown> {
    if (!this.#socket || this.#socket.destroyed) {
      return Promise.reject(new Error("DAO daemon connection is unavailable"));
    }
    const id = `web-request-${randomUUID()}`;
    const commandId = mutationMethods.has(method) ? `web-command-${randomUUID()}` : null;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`DAO method timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.#pending.set(id, { resolve, reject, timer });
      this.#socket!.write(`${JSON.stringify({
        version: 1,
        type: "command",
        request_id: id,
        client_id: this.#clientId,
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
    throw new Error(`DAO daemon did not start: ${String(lastError)}`);
  }

  private daemonSocketPath(): string {
    const runtime = this.daemonEnvironment.runtimeDirectory
      || process.env.DAO_RUNTIME_DIR
      || (process.env.XDG_RUNTIME_DIR
        ? join(process.env.XDG_RUNTIME_DIR, "dao")
        : join(tmpdir(), `dao-${process.getuid?.() ?? 0}`));
    return join(runtime, "daemon.sock");
  }

  private launchDaemon(): void {
    const release = join(this.repositoryRoot, "apps/tui-rs/target/release/dao");
    const debug = join(this.repositoryRoot, "apps/tui-rs/target/debug/dao");
    const executable = process.env.DAO_BIN
      || (existsSync(release) ? release : existsSync(debug) ? debug : "dao");
    const child = spawn(executable, [
      "daemon", "serve",
      "--repository-root", this.repositoryRoot,
      "--config", join(this.repositoryRoot, "agent.edn"),
    ], {
      cwd: this.workspaceRoot,
      detached: true,
      env: {
        ...process.env,
        ...(this.daemonEnvironment.runtimeDirectory
          ? { DAO_RUNTIME_DIR: this.daemonEnvironment.runtimeDirectory } : {}),
        ...(this.daemonEnvironment.stateDirectory
          ? { DAO_STATE_DIR: this.daemonEnvironment.stateDirectory } : {}),
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
          pending.reject(error as Error);
        }
      } else {
        pending.reject(Object.assign(
          new Error(message.error?.message || "DAO request failed"),
          { data: message.error?.data }));
      }
      return;
    }
    if (message.type === "event" || message.type === "run-result") {
      const event = { ...message, hostSeq: ++this.#hostSequence } as HostEvent;
      this.#events.push(event);
      if (this.#events.length > 2_000) this.#events.splice(0, this.#events.length - 2_000);
      this.emit("event", event);
    }
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
      throw new Error(`Incomplete DAO snapshot transfer: ${transferId}`);
    }
    const snapshot = JSON.parse(chunks.join(""));
    if (Object.keys(value).length === 1) return snapshot;
    const hydrated: Record<string, unknown> = { ...value, snapshot };
    delete hydrated.snapshot_transfer_id;
    return hydrated;
  }

  private fail(error: Error): void {
    this.#diagnostics = `${this.#diagnostics}\n${error.message}`.slice(-20_000);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (!this.#closed) this.#ready = null;
  }
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
