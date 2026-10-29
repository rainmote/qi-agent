import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startWebHost } from "./server.js";

test("owned Host close immediately followed by restart preserves identity, title, history and preset", {
  timeout: 45_000,
}, async () => {
  const root = await mkdtemp("/tmp/qi-owned-restart-");
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const workspace = join(root, "workspace");
  const presets = join(root, "presets");
  const previous = process.env.QI_AGENT_PRESET_USER_ROOT;
  const previousHome = process.env.QI_AGENT_HOME;
  let host: Awaited<ReturnType<typeof startWebHost>> | undefined;
  try {
    await mkdir(workspace);
    await mkdir(join(presets, "restart-fixture"), { recursive: true });
    await writeFile(join(presets, "restart-fixture", "preset.edn"), '{:name "Restart fixture"}');
    const profile = await readFile(join(repository, "examples/tui-mock.edn"), "utf8");
    await writeFile(join(presets, "restart-fixture", "agent.edn"), profile);
    process.env.QI_AGENT_PRESET_USER_ROOT = presets;
    process.env.QI_AGENT_HOME = join(root, "home");
    const options = { port: 0, workspace, stateDirectory: join(root, "web"), codexAuthFile: join(root, "missing-auth") };
    host = await startWebHost(options);
    const first = await host.sessions.create(host.workspaces.list()[0].id, "Saved Web session", "restart-fixture");
    await first.worker.call("turn.submit", { message: "Persist this user message." });
    const deadline = Date.now() + 10_000;
    let snapshot: any;
    do {
      snapshot = (await first.worker.snapshot()).snapshot;
      if (snapshot.state?.phase === "idle" && JSON.stringify(snapshot).includes("The TUI groups discovery tools")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.equal(snapshot.state.phase, "idle");
    assert.match(JSON.stringify(snapshot), /The TUI groups discovery tools/);
    const agents = await first.worker.callDaemon("agent.list") as Array<{ agent_id: string; session_path: string }>;
    const id = agents.find((agent) => agent.session_path === first.summary.path)!.agent_id;
    await host.close();
    host = await startWebHost(options);
    const reopened = await host.sessions.open(first.summary.id);
    assert.equal(reopened.summary.id, first.summary.id);
    assert.equal(reopened.summary.name, "Saved Web session");
    assert.equal(reopened.summary.presetId, "restart-fixture");
    assert.match(JSON.stringify(reopened.snapshot), /Persist this user message/);
    assert.match(JSON.stringify(reopened.snapshot), /The TUI groups discovery tools/);
    const restored = await reopened.worker.callDaemon("agent.list") as Array<{ agent_id: string; session_path: string }>;
    assert.deepEqual(restored.filter((agent) => agent.session_path === first.summary.path).map((agent) => agent.agent_id), [id]);
  } finally {
    await host?.close();
    if (previous === undefined) delete process.env.QI_AGENT_PRESET_USER_ROOT;
    else process.env.QI_AGENT_PRESET_USER_ROOT = previous;
    if (previousHome === undefined) delete process.env.QI_AGENT_HOME;
    else process.env.QI_AGENT_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});
