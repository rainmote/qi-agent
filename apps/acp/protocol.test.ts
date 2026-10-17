import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { AcpConnection, type AcpBackend, type AcpSession } from "./protocol.js";
import { LocalAcpBackend } from "./backend.js";
import { serve } from "./server.js";

type Obj = Record<string, any>;
class Worker extends EventEmitter {
  calls: Array<{ method: string; params: Obj; commandId?: string }> = [];
  closed = false;
  async call(method: string, params: Obj = {}, _timeout?: number, commandId?: string): Promise<unknown> {
    this.calls.push({ method, params, commandId });
    return method === "session.snapshot" ? { models: { current: { id: "mock" }, providers: [{ id: "mock", model: "offline" }] } } : { accepted: true };
  }
  async close() { this.closed = true; }
  subscribeClient() { return () => undefined; }
  event(event: string, data: Obj, extra: Obj = {}) { this.emit("event", { event, data, session_id: "session-1", ...extra }); }
}
function fixture(options: ConstructorParameters<typeof AcpConnection>[2] = {}) {
  const worker = new Worker(), output: Obj[] = [];
  const session: AcpSession = { id: "session-1", cwd: "/allowed", worker, snapshot: { events: [{ type: "message", data: { message: { role: "user", content: "history" } } }] } };
  const backend: AcpBackend = { create: async () => session, load: async () => session,
    list: async () => [{ sessionId: session.id, cwd: session.cwd }], preparePrompt: async (_session, content) => content, close: async () => undefined };
  const connection = new AcpConnection(backend, (message) => output.push(message), options);
  let id = 0;
  const request = async (method: string, params: Obj = {}) => {
    const current = ++id;
    await connection.receive({ jsonrpc: "2.0", id: current, method, params });
    return output.find((message) => message.id === current)!;
  };
  const ready = async () => { await request("initialize", { protocolVersion: 1 }); return request("session/new", { cwd: "/allowed", mcpServers: [] }); };
  return { worker, output, backend, connection, request, ready };
}
async function eventually(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  assert.ok(check(), "condition not reached");
}
test("ACP negotiates v1, rejects unknown methods and opens sessions under ask policy", async () => {
  const f = fixture();
  assert.equal((await f.request("session/list")).error.code, -32000);
  const initialized = await f.request("initialize", { protocolVersion: 2 });
  assert.equal(initialized.result.protocolVersion, 1);
  assert.equal(initialized.result.agentCapabilities.promptCapabilities.image, true);
  assert.equal((await f.request("initialize", { protocolVersion: 1 })).error.code, -32602);
  assert.equal((await f.request("session/new", { cwd: "/allowed" })).result.sessionId, "session-1");
  assert.deepEqual(f.worker.calls[0], { method: "policy.select", params: { mode: "ask" }, commandId: undefined });
  assert.equal((await f.request("not/a/method")).error.code, -32601);
  assert.equal((await f.request("session/list")).result.sessions.length, 1);
  await f.connection.close();
});
test("prompt streams text, correlated tools, and only resolves after matching completion", async () => {
  const f = fixture(); await f.ready();
  let finished = false;
  const prompt = f.request("session/prompt", { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] }).then((v) => { finished = true; return v; });
  await eventually(() => f.worker.calls.some((v) => v.method === "turn.submit"));
  const turn = f.worker.calls.find((v) => v.method === "turn.submit")!;
  assert.equal(turn.commandId, turn.params.request_id);
  f.worker.event("llm/stream", { type: "text/delta", delta: "answer" });
  f.worker.event("message", { message: { role: "assistant", content: "answer" } });
  f.worker.event("llm/stream", { type: "text/delta", delta: "child" }, { session_id: "child" });
  f.worker.event("tool/call", { "call-id": "call-1", name: "read", arguments: { path: "a" } });
  f.worker.event("tool/result", { "call-id": "call-1", "execution-id": "different", ok: false, content: "denied" });
  f.worker.event("remote/run-result", { request_id: "unrelated", ok: true });
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(finished, false);
  f.worker.event("remote/run-result", { request_id: turn.params.request_id, ok: true, result: {} });
  assert.equal((await prompt).result.stopReason, "end_turn");
  const updates = f.output.filter((v) => v.method === "session/update").map((v) => v.params.update);
  assert.deepEqual(updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content.text), ["answer"]);
  assert.deepEqual(updates.filter((u) => u.toolCallId).map((u) => [u.toolCallId, u.status]), [["call-1", "in_progress"], ["call-1", "failed"]]);
  await f.connection.close();
});
test("permission responses are explicit, deduplicated and invalid choices deny", async () => {
  const f = fixture(); await f.ready();
  f.worker.event("interaction/request", { id: "approval-1", title: "Execute", message: "write" });
  f.worker.event("interaction/request", { id: "approval-1", title: "Execute" });
  const prompts = f.output.filter((v) => v.method === "session/request_permission");
  assert.equal(prompts.length, 1);
  await f.connection.receive({ jsonrpc: "2.0", id: prompts[0].id, result: { outcome: { outcome: "selected", optionId: "unexpected" } } });
  await eventually(() => f.worker.calls.some((v) => v.method === "interaction.resolve"));
  assert.equal(f.worker.calls.at(-1)!.params.decision, "deny");
  await f.connection.close();
});
test("daemon-owned completion ID is adopted even when the event arrives before admission", async () => {
  const f = fixture(); await f.ready();
  const call = f.worker.call.bind(f.worker);
  f.worker.call = async (method, params = {}, timeout, commandId) => {
    const result = await call(method, params, timeout, commandId);
    if (method === "turn.submit") {
      f.worker.event("remote/run-result", { request_id: "daemon-assigned-id", ok: true, result: {} });
      return { accepted: true, request_id: "daemon-assigned-id" };
    }
    return result;
  };
  const prompt = await f.request("session/prompt", { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] });
  assert.equal(prompt.result.stopReason, "end_turn");
  await f.connection.close();
});
test("plan approval offers only its explicit revision-scoped choices", async () => {
  const f = fixture(); await f.ready();
  f.worker.event("interaction/request", { id: "plan-approval", items: [{ label: "Approve plan", value: "allow" }, { label: "Reject", value: "deny" }] });
  const prompt = f.output.find((message) => message.method === "session/request_permission")!;
  assert.deepEqual(prompt.params.options.map((option: Obj) => option.optionId), ["allow", "deny"]);
  await f.connection.receive({ jsonrpc: "2.0", id: prompt.id, result: { outcome: { outcome: "selected", optionId: "allow-session" } } });
  await eventually(() => f.worker.calls.some((v) => v.method === "interaction.resolve"));
  assert.equal(f.worker.calls.at(-1)!.params.decision, "deny");
  await f.connection.close();
});
test("MCP configurations are followed by explicit approval-bearing connection calls", async () => {
  const f = fixture(); await f.request("initialize", { protocolVersion: 1 });
  const response = await f.request("session/new", { cwd: "/allowed", mcpServers: [{ name: "local", command: "example", args: ["--stdio"], env: [] }] });
  assert.ok(response.result);
  assert.deepEqual(f.worker.calls.map((v) => v.method), ["policy.select", "mcp.configure", "mcp.control"]);
  assert.deepEqual(f.worker.calls.at(-1)!.params, { server: "local", action: "connect" });
  await f.connection.close();
});
test("cancel denies pending permission and reports cancelled at acknowledged turn completion", async () => {
  const f = fixture(); await f.ready();
  const prompt = f.request("session/prompt", { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] });
  await eventually(() => f.worker.calls.some((v) => v.method === "turn.submit"));
  f.worker.event("interaction/request", { id: "approval-2" });
  await f.request("session/cancel", { sessionId: "session-1" });
  const turn = f.worker.calls.find((v) => v.method === "turn.submit")!;
  f.worker.event("remote/run-result", { request_id: turn.params.request_id, ok: false });
  assert.equal((await prompt).result.stopReason, "cancelled");
  assert.ok(f.worker.calls.some((v) => v.method === "interaction.resolve" && v.params.decision === "deny"));
  await f.connection.close();
});
test("cancellation while preparing context never submits the prompt", async () => {
  const f = fixture(); await f.ready();
  let resume!: () => void;
  f.backend.preparePrompt = async () => { await new Promise<void>((resolve) => { resume = resolve; }); return "context"; };
  const prompt = f.request("session/prompt", { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] });
  await f.request("session/cancel", { sessionId: "session-1" }); resume();
  assert.equal((await prompt).result.stopReason, "cancelled");
  assert.ok(!f.worker.calls.some((v) => v.method === "turn.submit"));
  await f.connection.close();
});
test("deadline and worker disconnection are uncertain errors, never false success", async () => {
  for (const exit of [false, true]) {
    const f = fixture({ promptTimeoutMs: 20 }); await f.ready();
    const prompt = f.request("session/prompt", { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] });
    await eventually(() => f.worker.calls.some((v) => v.method === "turn.submit"));
    if (exit) f.worker.emit("exit");
    assert.equal((await prompt).error.data.status, "uncertain");
    await f.connection.close();
  }
});
test("stdio framing accepts concurrent permission replies and rejects oversized input", async () => {
  const f = fixture(), input = new PassThrough(), output = new PassThrough();
  let bytes = ""; output.on("data", (chunk) => { bytes += chunk.toString(); });
  const serving = serve(input, output, f.backend, 2048);
  input.write("bad json\n");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })}\n`);
  await eventually(() => bytes.includes('"id":1'));
  input.end(); await serving;
  const results = bytes.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(results[0].error.code, -32700); assert.equal(results[1].result.protocolVersion, 1);
  const badInput = new PassThrough(); const rejected = serve(badInput, new PassThrough(), f.backend, 32);
  badInput.write("x".repeat(33)); await assert.rejects(rejected, /frame limit/); badInput.destroy();
});
test("real backend confines resource links and embeds uploads without leaking bytes in references", async () => {
  const dir = await mkdtemp("/tmp/qi-acp-content-");
  const workspace = join(dir, "workspace"), state = join(dir, "state"), attachmentDirectory = join(dir, "attachments");
  await mkdir(workspace); await writeFile(join(workspace, "note.txt"), "source text");
  await writeFile(join(dir, "private.txt"), "private");
  const backend = await LocalAcpBackend.open({ stateDirectory: state, repositoryRoot: process.cwd(), roots: [workspace], environment: { attachmentDirectory } });
  try {
    const session: AcpSession = { id: "fake", cwd: workspace, worker: new Worker(), snapshot: {} };
    const content = await backend.preparePrompt(session, [{ type: "resource_link", uri: pathToFileURL(join(workspace, "note.txt")).href }]);
    assert.equal(content[0].type, "attachment"); assert.ok(!JSON.stringify(content).includes("source text"));
    await assert.rejects(backend.preparePrompt(session, [{ type: "resource_link", uri: pathToFileURL(join(dir, "private.txt")).href }]), /outside/);
    await assert.rejects(backend.preparePrompt(session, [{ type: "resource_link", uri: "https://example.test" }]), /local files/);
    await assert.rejects(backend.preparePrompt({ ...session, cwd: dir }, [{ type: "text", text: "a" }]), /not authorized/);
    await assert.rejects(backend.preparePrompt(session, [{ type: "audio", data: "anything" }]), /Unsupported/);
  } finally { await backend.close(); await rm(dir, { recursive: true, force: true }); }
});
test("saved ACP workspace indexes never expand a later invocation's authority", async () => {
  const dir = await mkdtemp("/tmp/qi-acp-roots-"), state = join(dir, "state");
  const first = join(dir, "first"), second = join(dir, "second");
  await mkdir(first); await mkdir(second);
  try {
    const original = await LocalAcpBackend.open({ stateDirectory: state, repositoryRoot: process.cwd(), roots: [first] });
    await original.close();
    const current = await LocalAcpBackend.open({ stateDirectory: state, repositoryRoot: process.cwd(), roots: [second] });
    try {
      assert.equal(current.workspaces.list().length, 1);
      assert.match(current.workspaces.list()[0].path, /\/second$/);
      await assert.rejects(current.list(first), /not authorized/);
    } finally { await current.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
