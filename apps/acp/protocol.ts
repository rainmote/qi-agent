import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";

type ObjectValue = Record<string, unknown>;
type RpcId = string | number;
export interface AcpWorker extends EventEmitter {
  call(method: string, params?: ObjectValue, timeoutMs?: number, commandId?: string): Promise<unknown>;
  close(): Promise<void>;
  subscribeClient(): () => void;
}
export interface AcpSession {
  id: string;
  cwd: string;
  title?: string;
  worker: AcpWorker;
  snapshot: ObjectValue;
}
export interface AcpBackend {
  create(cwd: string): Promise<AcpSession>;
  load(id: string, cwd?: string): Promise<AcpSession>;
  list(cwd?: string): Promise<Array<{ sessionId: string; cwd: string; title?: string; updatedAt?: string }>>;
  preparePrompt(session: AcpSession, content: ObjectValue[]): Promise<unknown>;
  close(): Promise<void>;
}
export class AcpError extends Error {
  constructor(message: string, readonly code = -32602, readonly data?: unknown) { super(message); }
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AcpError("Expected an object");
  return value as ObjectValue;
}
function string(value: unknown, name: string, max = 16_384): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new AcpError(`Invalid ${name}`);
  return value;
}
function textParts(content: unknown): string[] {
  if (typeof content === "string") return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => part?.type === "text" && typeof part.text === "string" ? [part.text] : []);
}
interface Running {
  requestId: string;
  resolve: (result: ObjectValue) => void;
  reject: (error: Error) => void;
  cancelled: boolean;
  streamed: boolean;
  timer: ReturnType<typeof setTimeout>;
  admitted: boolean;
  completions: Map<string, ObjectValue>;
}
interface Attached {
  session: AcpSession;
  release: () => void;
  event: (event: ObjectValue) => void;
  exit: () => void;
  running?: Running;
  starting: boolean;
  cancelled: boolean;
  permissions: Set<string>;
}

/** ACP v1 JSON-RPC adapter. All execution and authority remain in qi's daemon. */
export class AcpConnection {
  #initialized = false;
  #closed = false;
  #sessions = new Map<string, Attached>();
  #clientRequests = new Map<string, { sessionId: string; resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  #incoming = new Set<RpcId>();
  constructor(readonly backend: AcpBackend, readonly write: (message: ObjectValue) => void,
    readonly options: { promptTimeoutMs?: number; permissionTimeoutMs?: number; maxSessions?: number } = {}) {}

  async receive(raw: unknown): Promise<void> {
    let request: ObjectValue;
    try { request = object(raw); } catch { this.error(null, new AcpError("Invalid request", -32600)); return; }
    const id = request.id;
    if (request.jsonrpc !== "2.0") { this.error(null, new AcpError("Expected JSON-RPC 2.0", -32600)); return; }
    if (typeof request.method !== "string") {
      if (typeof id === "string") {
        const pending = this.#clientRequests.get(id);
        if (pending) {
          clearTimeout(pending.timer); this.#clientRequests.delete(id);
          pending.resolve(request.error ? { outcome: { outcome: "cancelled" } } : request.result);
        }
      }
      return;
    }
    const hasId = typeof id === "string" || typeof id === "number";
    if (hasId && this.#incoming.has(id as RpcId)) { this.error(id as RpcId, new AcpError("Request ID is already active", -32600)); return; }
    if (hasId && this.#incoming.size >= 64) { this.error(id as RpcId, new AcpError("Too many active requests", -32000)); return; }
    if (hasId) this.#incoming.add(id as RpcId);
    try {
      const result = await this.dispatch(request.method, request.params === undefined ? {} : object(request.params));
      if (hasId) this.write({ jsonrpc: "2.0", id, result });
    } catch (error) {
      if (hasId) this.error(id as RpcId, error);
    } finally { if (hasId) this.#incoming.delete(id as RpcId); }
  }
  private error(id: RpcId | null, error: unknown): void {
    this.write({ jsonrpc: "2.0", id, error: {
      code: error instanceof AcpError ? error.code : -32603,
      message: error instanceof Error ? error.message : "Internal error",
      ...(error instanceof AcpError && error.data !== undefined ? { data: error.data }
        : error instanceof Error && "data" in error ? { data: error.data } : {}),
    } });
  }
  private update(id: string, update: ObjectValue): void {
    if (!this.#closed) this.write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: id, update } });
  }
  private attached(params: ObjectValue): Attached {
    const id = string(params.sessionId, "sessionId", 256);
    const value = this.#sessions.get(id);
    if (!value) throw new AcpError("Session is not open on this connection");
    return value;
  }
  private config(snapshot: ObjectValue): ObjectValue {
    const models = snapshot.models as { current?: { id: string }; providers?: Array<{ id: string; model?: string; "display-name"?: string }> } | undefined;
    const entries = models?.providers || [];
    return { ...(entries.length ? {
      models: { currentModelId: models?.current?.id || entries[0].id,
        availableModels: entries.map((m) => ({ modelId: m.id, name: m["display-name"] || m.model || m.id })) },
      configOptions: [{ id: "model", name: "Model", category: "model", type: "select",
        currentValue: models?.current?.id || entries[0].id,
        options: entries.map((m) => ({ value: m.id, name: m["display-name"] || m.model || m.id })) }],
    } : { configOptions: [] }) };
  }
  private bind(session: AcpSession): Attached {
    const previous = this.#sessions.get(session.id);
    if (previous) return previous;
    if (this.#sessions.size >= (this.options.maxSessions ?? 16)) throw new AcpError("Open session limit reached", -32000);
    const attached: Attached = { session, release: session.worker.subscribeClient(), starting: false, cancelled: false, permissions: new Set(),
      event: (event) => this.onEvent(session.id, event),
      exit: () => { attached.running?.reject(new AcpError("Worker disconnected; execution outcome may be uncertain", -32000, { status: "uncertain" })); },
    };
    session.worker.on("event", attached.event); session.worker.on("exit", attached.exit);
    this.#sessions.set(session.id, attached);
    if (Array.isArray(session.snapshot.interactions)) for (const request of session.snapshot.interactions) {
      if (request && typeof request === "object") void this.permission(attached, request as ObjectValue);
    }
    return attached;
  }
  private async configureMcp(attached: Attached, value: unknown): Promise<void> {
    if (value === undefined) return;
    if (!Array.isArray(value) || value.length > 16) throw new AcpError("mcpServers must contain at most 16 servers");
    if (!value.length) return;
    const servers = value.map((input) => {
      const server = object(input);
      const id = string(server.name, "MCP server name", 20);
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AcpError("MCP server names must use 1–20 letters, digits, underscores or hyphens");
      if (server.type === "http") return { id, transport: "streamable-http", url: string(server.url, "MCP URL"),
        headers: Object.fromEntries((Array.isArray(server.headers) ? server.headers : []).map((h: ObjectValue) => [string(h.name, "header"), string(h.value, "header value")])), enabled: true };
      if (server.type !== undefined && server.type !== "stdio") throw new AcpError("Only stdio and HTTP MCP servers are supported");
      if (!Array.isArray(server.args) || !server.args.every((arg) => typeof arg === "string")) throw new AcpError("Invalid MCP args");
      const env = Object.fromEntries((Array.isArray(server.env) ? server.env : []).map((item: ObjectValue) => [string(item.name, "environment name"), String(item.value ?? "")]));
      return { id, transport: "stdio", command: [string(server.command, "MCP command"), ...server.args], env, enabled: true };
    });
    await attached.session.worker.call("mcp.configure", { servers }, 300_000);
    for (const server of servers) await attached.session.worker.call("mcp.control", { server: server.id, action: "connect" }, 300_000);
  }
  private async dispatch(method: string, params: ObjectValue): Promise<unknown> {
    if (this.#closed) throw new AcpError("Connection is closed", -32000);
    if (method === "initialize") {
      if (this.#initialized) throw new AcpError("Already initialized");
      if (!Number.isInteger(params.protocolVersion) || Number(params.protocolVersion) < 1) throw new AcpError("Unsupported protocol version");
      this.#initialized = true;
      return { protocolVersion: 1, agentInfo: { name: "qi-agent", title: "qì agent", version: "0.1.0" },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false }, sessionCapabilities: { list: {}, resume: {}, close: {} } }, authMethods: [] };
    }
    if (!this.#initialized) throw new AcpError("Initialize the connection first", -32000);
    if (method === "authenticate") throw new AcpError("Configure model credentials locally; this adapter does not accept credentials", -32601);
    if (method === "session/new") {
      if (this.#sessions.size >= (this.options.maxSessions ?? 16)) throw new AcpError("Open session limit reached", -32000);
      const attached = this.bind(await this.backend.create(string(params.cwd, "cwd")));
      try {
        // New IDE sessions ask before writes. Resuming a session preserves its user's existing policy.
        await attached.session.worker.call("policy.select", { mode: "ask" });
        await this.configureMcp(attached, params.mcpServers);
        return { sessionId: attached.session.id, ...this.config(attached.session.snapshot) };
      } catch (error) { await this.closeSession(attached); throw error; }
    }
    if (method === "session/list") {
      const entries = await this.backend.list(typeof params.cwd === "string" ? params.cwd : undefined);
      const offset = params.cursor === undefined ? 0 : Number(params.cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new AcpError("Invalid cursor");
      return { sessions: entries.slice(offset, offset + 100), ...(entries.length > offset + 100 ? { nextCursor: String(offset + 100) } : {}) };
    }
    if (method === "session/load" || method === "session/resume") {
      const existing = this.#sessions.get(String(params.sessionId));
      if (existing?.running || existing?.starting) throw new AcpError("Cannot reload a session during a prompt");
      const attached = this.bind(await this.backend.load(string(params.sessionId, "sessionId", 256),
        typeof params.cwd === "string" ? params.cwd : undefined));
      await this.configureMcp(attached, params.mcpServers);
      if (method === "session/load") {
        for (const event of (attached.session.snapshot.events as ObjectValue[] || [])) {
          if (event.type === "message") {
            const message = (event.data as ObjectValue)?.message as ObjectValue | undefined;
            if (message && ["user", "assistant"].includes(String(message.role))) {
              for (const text of textParts(message.content)) this.update(attached.session.id, {
                sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text },
              });
            }
          }
        }
      }
      return { ...this.config(attached.session.snapshot) };
    }
    if (method === "session/close") { await this.closeSession(this.attached(params)); return {}; }
    if (method === "session/cancel") {
      const attached = this.attached(params);
      attached.cancelled = true;
      if (attached.running) attached.running.cancelled = true;
      this.cancelPermissions(attached.session.id);
      await attached.session.worker.call("turn.abort");
      return {};
    }
    if (method === "session/set_model" || method === "session/set_config_option") {
      const attached = this.attached(params);
      if (attached.running || attached.starting) throw new AcpError("Cannot change model during a prompt");
      if (method === "session/set_config_option" && params.configId !== "model") throw new AcpError("Unknown config option");
      const provider = string(method === "session/set_model" ? params.modelId : params.value, "model", 256);
      await attached.session.worker.call("model.select", { provider });
      attached.session.snapshot = object(await attached.session.worker.call("session.snapshot"));
      return method === "session/set_model" ? {} : { configOptions: this.config(attached.session.snapshot).configOptions };
    }
    if (method === "session/prompt") {
      const attached = this.attached(params);
      if (attached.running || attached.starting) throw new AcpError("A prompt is already running", -32000);
      if (!Array.isArray(params.prompt) || !params.prompt.length || params.prompt.length > 9) throw new AcpError("prompt must contain 1–9 content blocks");
      attached.starting = true;
      attached.cancelled = false;
      try {
        const message = await this.backend.preparePrompt(attached.session, params.prompt.map(object));
        if (attached.cancelled || this.#closed || !this.#sessions.has(attached.session.id)) return { stopReason: "cancelled" };
        const requestId = `acp-turn-${randomUUID()}`;
        let running!: Running;
        const result = new Promise<ObjectValue>((resolve, reject) => {
          const timer = setTimeout(() => {
            void attached.session.worker.call("turn.abort").catch(() => undefined);
            reject(new AcpError("Prompt deadline exceeded; inspect session before retrying", -32000, { status: "uncertain", requestId: running.requestId }));
          }, this.options.promptTimeoutMs ?? 1_800_000);
          running = { requestId, resolve, reject, cancelled: false, streamed: false, timer, admitted: false, completions: new Map() };
          attached.running = running;
        });
        // Attach rejection handling before waiting for admission; completion can precede its response.
        void result.catch(() => undefined);
        try {
          const admission = object(await attached.session.worker.call("turn.submit", { message, request_id: requestId }, 30_000, requestId));
          // The daemon owns execution IDs. Its completion can race ahead of admission.
          running.requestId = typeof admission.request_id === "string" ? admission.request_id : requestId;
          running.admitted = true;
          const completion = running.completions.get(running.requestId);
          running.completions.clear();
          if (completion) this.onEvent(attached.session.id, completion);
          return await result;
        } finally {
          clearTimeout(running.timer);
          attached.running = undefined; this.cancelPermissions(attached.session.id);
        }
      } finally { attached.starting = false; }
    }
    throw new AcpError(`Method not found: ${method}`, -32601);
  }
  private onEvent(id: string, event: ObjectValue): void {
    const attached = this.#sessions.get(id);
    if (!attached) return;
    // Child streams share the worker socket; only publish the attached session here.
    if (event.session_id && event.session_id !== id) return;
    const data = event.data as ObjectValue || {};
    if (event.event === "interaction/request") { void this.permission(attached, data); return; }
    const running = attached.running;
    if (!running) return;
    if (event.event === "step/start") running.streamed = false;
    if (event.event === "llm/stream" && ["text/delta", "delta"].includes(String(data.type)) && typeof data.delta === "string") {
      running.streamed = true;
      this.update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: data.delta } });
    }
    if (event.event === "message" && !running.streamed) {
      const message = data.message as ObjectValue | undefined;
      if (message?.role === "assistant") for (const text of textParts(message.content)) {
        this.update(id, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
      }
    }
    if (event.event === "tool/call") this.update(id, { sessionUpdate: "tool_call", toolCallId: String(data["call-id"] || data.id || data["tool-call-id"] || data["execution-id"] || "tool"),
      title: String(data.name || "Tool"), kind: "other", status: "in_progress", rawInput: data.arguments });
    if (event.event === "tool/result") this.update(id, { sessionUpdate: "tool_call_update", toolCallId: String(data["call-id"] || data.id || data["tool-call-id"] || data["execution-id"] || "tool"),
      status: data.ok === false ? "failed" : "completed", rawOutput: data.content,
      content: typeof data.content === "string" ? [{ type: "content", content: { type: "text", text: data.content } }] : [] });
    if (event.event === "remote/run-result" && !running.admitted && typeof data.request_id === "string") {
      if (running.completions.size < 32) running.completions.set(data.request_id, event);
      return;
    }
    if (event.event === "remote/run-result" && data.request_id === running.requestId) {
      const value = data.result as ObjectValue || {};
      if (running.cancelled) running.resolve({ stopReason: "cancelled" });
      else if (data.ok === false) running.reject(new AcpError(String((data.error as ObjectValue)?.message || "Agent turn failed"), -32000, data.error));
      else running.resolve({ stopReason: value["stop-reason"] === "max-steps" ? "max_turn_requests" : "end_turn" });
    }
  }
  private async permission(attached: Attached, request: ObjectValue): Promise<void> {
    if (typeof request.id !== "string" || attached.permissions.has(request.id)) return;
    attached.permissions.add(request.id);
    if (attached.cancelled || this.#closed) {
      await attached.session.worker.call("interaction.resolve", { id: request.id, decision: "deny" }).catch(() => undefined);
      return;
    }
    if (attached.permissions.size > 2048) attached.permissions.delete(attached.permissions.values().next().value!);
    const id = `acp-permission-${randomUUID()}`;
    const defaults = [{ label: "Allow once", value: "allow" }, { label: "Allow for session", value: "allow-session" }, { label: "Deny", value: "deny" }];
    const requested = Array.isArray(request.items) ? request.items as Array<{ label?: string; value?: string }> : defaults;
    const choices = defaults.flatMap((fallback) => {
      const found = requested.find((item) => item?.value === fallback.value);
      return found ? [{ optionId: fallback.value, name: typeof found.label === "string" ? found.label : fallback.label,
        kind: ({ allow: "allow_once", "allow-session": "allow_always", deny: "reject_once" } as Record<string, string>)[fallback.value] }] : [];
    });
    if (!choices.length) {
      await attached.session.worker.call("interaction.resolve", { id: request.id, decision: "deny" }).catch(() => undefined);
      return;
    }
    const result = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => { this.#clientRequests.delete(id); resolve({ outcome: { outcome: "cancelled" } }); },
        this.options.permissionTimeoutMs ?? 300_000);
      this.#clientRequests.set(id, { sessionId: attached.session.id, resolve, timer });
      this.write({ jsonrpc: "2.0", id, method: "session/request_permission", params: {
        sessionId: attached.session.id,
        toolCall: { toolCallId: request.id, title: String(request.title || "Permission required"), status: "pending", kind: "other",
          content: [{ type: "content", content: { type: "text", text: String(request.message || "") } }] },
        options: choices,
      } });
    });
    const outcome = (result as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
    const decision = outcome?.outcome === "selected" && choices.some((choice) => choice.optionId === outcome.optionId) ? outcome.optionId : "deny";
    await attached.session.worker.call("interaction.resolve", { id: request.id, decision }).catch(() => undefined);
  }
  private cancelPermissions(sessionId: string): void {
    for (const [id, pending] of this.#clientRequests) if (pending.sessionId === sessionId) {
      clearTimeout(pending.timer); this.#clientRequests.delete(id); pending.resolve({ outcome: { outcome: "cancelled" } });
    }
  }
  private async closeSession(attached: Attached): Promise<void> {
    attached.cancelled = true;
    this.cancelPermissions(attached.session.id);
    if (attached.running) {
      attached.running.cancelled = true;
      await attached.session.worker.call("turn.abort").catch(() => undefined);
      attached.running.resolve({ stopReason: "cancelled" });
    }
    attached.session.worker.off("event", attached.event); attached.session.worker.off("exit", attached.exit);
    attached.release(); this.#sessions.delete(attached.session.id);
    await attached.session.worker.close();
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled([...this.#sessions.values()].map((session) => this.closeSession(session)));
    await this.backend.close();
  }
}
