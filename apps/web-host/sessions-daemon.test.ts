import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "./sessions.js";
import { WorkspaceRegistry } from "./workspaces.js";
import { AgentWorker } from "./worker.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function waitForExit(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

test("SessionManager archives through the real isolated daemon and retains lifecycle across restart", {
  timeout: 60_000,
}, async () => {
  // Short paths keep Unix sockets within the macOS limit. All settings,
  // transcripts and mock execution state belong to this temporary directory.
  const root = await realpath(await mkdtemp("/tmp/qi-session-"));
  const workspace = join(root, "workspace");
  const webState = join(root, "web");
  const runtime = join(root, "run");
  const state = join(root, "daemon");
  const settings = join(root, "providers.json");
  const environment = { runtimeDirectory: runtime, stateDirectory: state, providerSettingsPath: settings };
  const executable = process.env.QI_AGENT_BIN || join(repositoryRoot, "apps/tui-rs/target/debug/qi-agent");
  let child: ChildProcess | undefined;
  let diagnostics = "";
  const managers: SessionManager[] = [];
  let observer: AgentWorker | undefined;
  const launch = async () => {
    child = spawn(executable, ["daemon", "serve", "--repository-root", repositoryRoot,
      "--config", join(repositoryRoot, "examples/tui-mock.edn")], {
      cwd: root,
      env: {
        ...process.env,
        QI_AGENT_HOME: join(root, "home"),
        QI_AGENT_PRESET_USER_ROOT: join(root, "presets"),
        QI_AGENT_RUNTIME_DIR: runtime,
        QI_AGENT_STATE_DIR: state,
        QI_AGENT_PROVIDER_SETTINGS_FILE: settings,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (bytes: Buffer) => {
      diagnostics = `${diagnostics}${bytes.toString("utf8")}`.slice(-8_000);
    });
    let launchError: Error | undefined;
    child.on("error", (error) => { launchError = error; });
    const deadline = Date.now() + 15_000;
    while (!existsSync(join(runtime, "daemon.sock"))) {
      if (launchError) throw launchError;
      assert.equal(child.exitCode, null, diagnostics);
      assert.ok(Date.now() < deadline, `Daemon did not start: ${diagnostics}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await mkdir(workspace);
    await writeFile(settings, "{}\n");
    const registry = new WorkspaceRegistry(webState);
    await registry.load(workspace);
    await launch();
    const manager = new SessionManager(registry, repositoryRoot, environment);
    managers.push(manager);
    const opened = await manager.create(registry.list()[0].id);
    const original = await readFile(opened.summary.path, "utf8");
    const archivePath = join(workspace, ".qi-agent", "archive", "sessions",
      opened.summary.path.split("/").at(-1)!);

    const other = new SessionManager(registry, repositoryRoot, environment);
    managers.push(other);
    await assert.rejects(other.archive(opened.summary.id), /control/i,
      "An unopened session must not bypass another client's controller lease");
    assert.equal(await readFile(opened.summary.path, "utf8"), original);
    assert.deepEqual(await manager.archive(opened.summary.id), { archived: true });
    assert.equal(existsSync(opened.summary.path), false);
    assert.equal(await readFile(archivePath, "utf8"), original);
    assert.deepEqual(await manager.listAll(), []);

    observer = new AgentWorker(workspace, join(workspace, ".observer"), repositoryRoot, environment);
    const agents = await observer.callDaemon("agent.list") as Array<{
      status: string; session_path: string;
    }>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0].status, "stopped");
    assert.equal(agents[0].session_path, archivePath);
    await observer.close();
    observer = undefined;
    child!.kill("SIGKILL");
    await waitForExit(child!);
    // A killed daemon may leave its socket inode; the restarted daemon binds
    // a new socket before this integration client is allowed to connect.
    await rm(join(runtime, "daemon.sock"), { force: true });
    await launch();
    const restored = new SessionManager(registry, repositoryRoot, environment);
    managers.push(restored);
    assert.deepEqual(await restored.listAll(), []);
    assert.deepEqual(await restored.archive(opened.summary.id), { archived: true });
    await assert.rejects(restored.open(opened.summary.id), /not found/);

    const legacyPath = join(workspace, ".bb-agent", "sessions", "legacy.jsonl");
    const legacyArchive = join(workspace, ".bb-agent", "archive", "sessions", "legacy.jsonl");
    const legacy = `${JSON.stringify({ type: "session/start", data: { session_id: "legacy" } })}\n`;
    await mkdir(dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, legacy);
    assert.deepEqual(await restored.archive("legacy"), { archived: true });
    assert.equal(await readFile(legacyArchive, "utf8"), legacy);
    observer = new AgentWorker(workspace, join(workspace, ".observer"), repositoryRoot, environment);
    const restoredAgents = await observer.callDaemon("agent.list") as Array<{
      status: string; session_path: string;
    }>;
    assert.equal(restoredAgents.length, 1, "Historical archive must not hydrate a worker");
    assert.equal(restoredAgents[0].status, "stopped");
    assert.equal(restoredAgents[0].session_path, archivePath);
  } finally {
    await Promise.allSettled(managers.map((manager) => manager.closeAll()));
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      observer ||= new AgentWorker(workspace, join(workspace, ".observer"), repositoryRoot, environment);
      try {
        await observer.callDaemon("daemon.shutdown", {}, 2_000);
      } catch {
        child.kill("SIGKILL");
      }
      await waitForExit(child);
    }
    await observer?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
