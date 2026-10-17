import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LocalAcpBackend } from "./backend.js";
import { AcpConnection } from "./protocol.js";

type Obj = Record<string, any>;
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const providerFixture = `(ns acp-offline-fixture
  (:require [qi.kernel :as kernel] [clojure.string :as str]))
(def plugin
 {:id :test/acp-offline :requires #{:llm/registry}
  :start (fn [ctx _]
    (kernel/register-tool! ctx
     {:name "fixture_write" :description "Write only the isolated test marker."
      :requires-approval true :parameters {:type "object" :additionalProperties false}
      :execute (fn [_ _] (spit "acp-effect.txt" "approved") {:written true})})
    (let [generate (fn [request]
       (let [messages (:messages request)
             last-user (last (filter #(= "user" (:role %)) messages))
             text (if (string? (:content last-user)) (:content last-user)
                      (str/join " " (map :text (:content last-user))))
             tools-done (= "tool" (:role (last messages)))]
         (if (and (str/includes? text "[write]") (not tools-done))
           {:message {:role "assistant" :content nil
                      :tool_calls [{:id "fixture-call-1" :type "function"
                                    :function {:name "fixture_write" :arguments "{}"}}]}
            :finish-reason "tool_calls"}
           (let [answer (if (str/includes? text "[image]")
                          (if (some #(and (= "image" (:type %)) (str/starts-with? (:url %) "data:image/png;base64,")) (:content last-user))
                            "image resolved" "image missing") "offline answer")]
             (kernel/emit! ctx :llm/stream {:type :text/delta :delta (subs answer 0 3)})
             (kernel/emit! ctx :llm/stream {:type :text/delta :delta (subs answer 3)})
             {:message {:role "assistant" :content answer} :finish-reason "stop"}))))]
      (doseq [id [:offline :offline-alt]]
        (kernel/track-effect! ctx ((:register! (kernel/require-service ctx :llm/registry))
          {:id id :model (name id) :provider :mock :input-modalities #{:text :image} :generate generate}))))
    nil)})`;
const configFixture = `{:plugins
 [{:ns qi.plugins.session}
  {:ns qi.plugins.model-registry :config {:default-provider :offline}}
  {:ns acp-offline-fixture}
  {:ns qi.plugins.execution-world :config {:root "."}}
  {:ns qi.plugins.remote-registry}
  {:ns qi.plugins.durable-state :config {:root "."}}
  {:ns qi.plugins.planning}
  {:ns qi.plugins.remote-interaction :config {:timeout-ms 10000}}
  {:ns qi.plugins.approval :config {:mode :deny}}
  {:ns qi.plugins.policy}
  {:ns qi.plugins.runtime :config {:max-steps 3}}
  {:ns qi.plugins.remote-api}]}`;

async function eventually(predicate: () => boolean, message: string, timeout = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) assert.fail(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function shutdown(socket: string) {
  await new Promise<void>(resolve => {
    const stream = createConnection(socket); const timer = setTimeout(() => { stream.destroy(); resolve(); }, 1500);
    stream.on("error", () => { clearTimeout(timer); resolve(); });
    stream.on("data", () => { clearTimeout(timer); stream.destroy(); resolve(); });
    stream.on("connect", () => stream.write(JSON.stringify({ version: 1, type: "command", request_id: "cleanup", command_id: "cleanup",
      client_id: "isolated-acp-test-cleanup", method: "daemon.shutdown", params: {} }) + "\n"));
  });
}
async function fixture() {
  const binary = join(repository, "apps/tui-rs/target/debug/qi-agent");
  assert.ok(existsSync(binary), "Build the debug daemon before running this integration test");
  const root = await realpath(await mkdtemp("/tmp/qacp-"));
  const repo = join(root, "repo"), workspace = join(root, "workspace"), runtime = join(root, "runtime"), state = join(root, "state"), home = join(root, "home"), attachments = join(root, "attachments");
  for (const path of [repo, join(repo, "plugins"), workspace, runtime, state, home, attachments]) await mkdir(path, { recursive: true, mode: 0o700 });
  await symlink(join(repository, "src"), join(repo, "src"));
  await writeFile(join(repo, "plugins/acp_offline_fixture.clj"), providerFixture);
  await writeFile(join(repo, "agent.edn"), configFixture);
  await writeFile(join(home, "trust.edn"), `{:roots {${JSON.stringify(workspace)} :allow}}`, { mode: 0o600 });
  const providerPath = join(root, "providers.json");
  let diagnostics = "";
  const child = spawn(binary, ["daemon", "serve", "--repository-root", repo, "--config", join(repo, "agent.edn")],
    { cwd: workspace, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env,
      QI_AGENT_HOME: home, DAO_HOME: home, QI_AGENT_RUNTIME_DIR: runtime, DAO_RUNTIME_DIR: runtime,
      QI_AGENT_STATE_DIR: state, DAO_STATE_DIR: state, QI_AGENT_REPOSITORY_ROOT: repo,
      QI_AGENT_PROVIDER_SETTINGS: providerPath, QI_AGENT_ATTACHMENT_DIR: attachments } });
  child.stderr!.on("data", chunk => { diagnostics += String(chunk); });
  const socket = join(runtime, "daemon.sock");
  try {
    await eventually(() => existsSync(socket) || child.exitCode !== null, "isolated daemon failed to start");
    assert.equal(child.exitCode, null, diagnostics);
    const backend = await LocalAcpBackend.open({ stateDirectory: join(root, "acp-state"), repositoryRoot: repo, roots: [workspace],
      environment: { runtimeDirectory: runtime, stateDirectory: state, providerSettingsPath: providerPath,
        attachmentDirectory: attachments, clientNamespace: "isolated-acp-test", idleDetachMs: 60000 } });
    const output: Obj[] = [];
    const connection = new AcpConnection(backend, message => output.push(message), { promptTimeoutMs: 8000, permissionTimeoutMs: 8000 });
    let serial = 0;
    const request = async (method: string, params: Obj = {}) => {
      const id = ++serial;
      await connection.receive({ jsonrpc: "2.0", id, method, params });
      const result = output.find(message => message.id === id)!;
      assert.ok(result, `missing ACP response for ${method}`);
      if (result.error) {
        for (const directory of [runtime, state]) {
          for (const path of await readdir(directory, { recursive: true })) {
            if (path.endsWith(".log")) diagnostics += `\n${path}: ${await readFile(join(directory, path), "utf8")}`;
          }
        }
      }
      assert.equal(result.error, undefined, `${method}: ${JSON.stringify(result.error)}; daemon: ${diagnostics}`);
      return result.result;
    };
    return { root, workspace, attachments, backend, connection, output, request,
      close: async () => { await connection.close(); await shutdown(socket); await stop(child); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await shutdown(socket); await stop(child); await rm(root, { recursive: true, force: true }); throw error; }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise<void>(resolve => child.once("exit", () => resolve())); }
}
const updates = (output: Obj[], start = 0) => output.slice(start).filter(message => message.method === "session/update").map(message => message.params.update);

test("ACP integrates with isolated real daemon: streaming, attachment resolution, model selection, permissions, cancellation and reload", { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request("initialize", { protocolVersion: 1 })).protocolVersion, 1);
    const opened = await f.request("session/new", { cwd: f.workspace, mcpServers: [] });
    const sessionId = opened.sessionId;
    assert.deepEqual(opened.models.availableModels.map((entry: Obj) => entry.modelId).sort(), ["offline", "offline-alt"]);
    const live = await f.backend.load(sessionId, f.workspace);
    assert.equal((await live.worker.call("policy.status") as Obj).mode, "ask");
    await f.request("session/set_model", { sessionId, modelId: "offline-alt" });
    const configured = await f.request("session/set_config_option", { sessionId, configId: "model", value: "offline" });
    assert.equal(configured.configOptions[0].currentValue, "offline");
    let start = f.output.length;
    assert.equal((await f.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] })).stopReason, "end_turn");
    assert.equal(updates(f.output, start).filter(update => update.sessionUpdate === "agent_message_chunk").map(update => update.content.text).join(""), "offline answer");
    start = f.output.length;
    const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=";
    assert.equal((await f.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "[image] inspect" }, { type: "image", mimeType: "image/png", data: image }] })).stopReason, "end_turn");
    assert.equal(updates(f.output, start).filter(update => update.sessionUpdate === "agent_message_chunk").map(update => update.content.text).join(""), "image resolved");
    const snapshot = await live.worker.call("session.snapshot") as Obj;
    assert.ok(JSON.stringify(snapshot).includes('"type":"attachment"'), "session should persist an attachment reference");
    assert.ok(!JSON.stringify(snapshot).includes(image), "session must not persist inline image bytes");
    for (const choice of ["deny", "allow", "cancel"]) {
      start = f.output.length;
      const prompt = f.request("session/prompt", { sessionId, prompt: [{ type: "text", text: `[write] ${choice}` }] });
      await eventually(() => f.output.slice(start).some(message => message.method === "session/request_permission"), "missing real worker permission request");
      const permission = f.output.slice(start).find(message => message.method === "session/request_permission")!;
      if (choice === "cancel") await f.request("session/cancel", { sessionId });
      else await f.connection.receive({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "selected", optionId: choice } } });
      assert.equal((await prompt).stopReason, choice === "cancel" ? "cancelled" : "end_turn");
      const calls = updates(f.output, start).filter(update => update.sessionUpdate === "tool_call");
      const results = updates(f.output, start).filter(update => update.sessionUpdate === "tool_call_update");
      assert.equal(calls[0]?.toolCallId, "fixture-call-1");
      if (choice !== "cancel") assert.equal(results[0]?.toolCallId, calls[0].toolCallId);
      if (choice === "deny") assert.equal(existsSync(join(f.workspace, "acp-effect.txt")), false);
      if (choice === "allow") assert.equal(await readFile(join(f.workspace, "acp-effect.txt"), "utf8"), "approved");
    }
    await f.request("session/close", { sessionId });
    start = f.output.length;
    await f.request("session/load", { sessionId, cwd: f.workspace });
    assert.ok(updates(f.output, start).some(update => update.sessionUpdate === "user_message_chunk"), "load must replay actual persisted user history");
    assert.ok((await f.request("session/list", { cwd: f.workspace })).sessions.some((entry: Obj) => entry.sessionId === sessionId));
    assert.equal((await f.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "after reload" }] })).stopReason, "end_turn");
    // Planning submits a blocking RPC, but its approval reply must still be
    // accepted by the same worker stdin loop and routed through ACP.
    const reloaded = await f.backend.load(sessionId, f.workspace);
    const draft = await reloaded.worker.call("planning.create", { title: "Offline plan", steps: [{ id: "check", title: "Verify fixture" }] }) as Obj;
    start = f.output.length;
    const submitted = reloaded.worker.call("planning.submit", { expected_revision: draft.plan.revision }, 5000) as Promise<Obj>;
    await eventually(() => f.output.slice(start).some(message => message.method === "session/request_permission"), "blocking plan RPC did not request approval");
    const permission = f.output.slice(start).find(message => message.method === "session/request_permission")!;
    await f.connection.receive({ jsonrpc: "2.0", id: permission.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    assert.equal((await submitted).plan.status, "approved", "planning.submit must not block interaction.resolve");
    for (const action of ["pause", "cancel", "exit"]) {
      const previous = await reloaded.worker.call("planning.show") as Obj;
      if (previous.plan) await reloaded.worker.call("planning.exit", { expected_revision: previous.plan.revision });
      const created = await reloaded.worker.call("planning.create", { title: `Interrupt by ${action}`, steps: [{ id: "check", title: "Verify fixture" }] }) as Obj;
      start = f.output.length;
      let settled = false;
      const pending = reloaded.worker.call("planning.submit", { expected_revision: created.plan.revision }, 5000).then(() => null, error => error as Error).finally(() => { settled = true; });
      await eventually(() => settled || f.output.slice(start).some(message => message.method === "session/request_permission"), `missing ${action} plan approval`);
      if (settled) assert.fail(`${action} submit finished before approval: ${String(await pending)}`);
      const stopped = await reloaded.worker.call(`planning.${action}`, { expected_revision: created.plan.revision + 1 }, 3000) as Obj;
      assert.equal(stopped.plan?.status || null, action === "exit" ? null : action === "cancel" ? "cancelled" : "paused");
      const failure = await pending;
      assert.ok(failure instanceof Error && !failure.message.includes("timed out"), `${action} must interrupt pending submit without deadlock`);
      const oldPermission = f.output.slice(start).find(message => message.method === "session/request_permission")!;
      await f.connection.receive({ jsonrpc: "2.0", id: oldPermission.id, result: { outcome: { outcome: "cancelled" } } });
    }

  } finally { await f.close(); }
});
