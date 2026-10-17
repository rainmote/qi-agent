// Production browser -> real Web Host -> isolated Rust daemon -> offline Babashka worker.
// No provider credentials, real model calls, or existing daemon/profile are used.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { startWebHost } from "../../web-host/server.js";
import type { SessionSnapshot } from "../src/types.js";

const repository = resolve(import.meta.dirname, "../../..");
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await delay(40);
  }
}

test("production Web trust, cancellation, recovery and composer E2E", { timeout: 120_000 }, async t => {
  const root = await realpath(await mkdtemp("/tmp/qi-web-e2e-"));
  const project = join(root, "project"), initial = join(root, "initial");
  const preset = join(root, "presets", "web-e2e");
  const artifacts = process.env.QI_AGENT_E2E_ARTIFACTS;
  const env = { QI_AGENT_HOME: join(root, "home"), QI_AGENT_PRESET_USER_ROOT: join(root, "presets") };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  let host: Awaited<ReturnType<typeof startWebHost>> | undefined;
  let daemon: ChildProcess | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Page | undefined;
  let diagnostics = "";
  const errors: string[] = [];
  const scenario = async (name: string, run: () => Promise<void>) => {
    let failure: unknown;
    await t.test(name, async () => { try { await run(); } catch (error) { failure = error; throw error; } });
    if (failure) throw failure;
  };
  try {
    for (const directory of [project, initial, preset, env.QI_AGENT_HOME]) await mkdir(directory, { recursive: true });
    await writeFile(join(preset, "preset.edn"), '{:name "离线 E2E" :description "Deterministic browser fixture" :order 0}\n');
    await copyFile(join(repository, "test/fixtures/web-interaction-mock.edn"), join(preset, "agent.edn"));
    Object.assign(process.env, env);
    host = await startWebHost({ port: 0, workspace: initial, stateDirectory: join(root, "web") });
    const environment = host.sessions.daemonEnvironment;
    daemon = spawn(process.env.QI_AGENT_BIN || join(repository, "apps/tui-rs/target/debug/qi-agent"),
      ["daemon", "serve", "--repository-root", repository, "--config", join(preset, "agent.edn")], {
        cwd: root, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env,
          QI_AGENT_RUNTIME_DIR: environment.runtimeDirectory, QI_AGENT_STATE_DIR: environment.stateDirectory,
          QI_AGENT_PROVIDER_SETTINGS_FILE: environment.providerSettingsPath },
      });
    daemon.stderr?.on("data", bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-8_000); });
    daemon.on("error", error => errors.push(error.message));
    await until(async () => {
      assert.equal(daemon!.exitCode, null, diagnostics);
      return existsSync(join(environment.runtimeDirectory!, "daemon.sock"));
    }, "Isolated daemon did not start");
    browser = await chromium.launch({ headless: true,
      ...(process.env.QI_AGENT_BROWSER_CHANNEL ? { channel: process.env.QI_AGENT_BROWSER_CHANNEL } : {}) });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(12_000);
    page.on("pageerror", error => errors.push(error.message));
    const calls: Array<{ path: string; body: any }> = [];
    let rejectTrust = false, rejectStop = false, rejectApproval = false, dropTrustResponse = false, dropStopResponse = false;
    let holdStop: Promise<void> | null = null;
    const origin = new URL(host.url).origin;
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { errors.push(`Unexpected external browser request: ${url.origin}`); await route.abort(); return; }
      if (request.method() === "POST") {
        const body = request.postDataJSON(); calls.push({ path: url.pathname, body });
        if (url.pathname === "/api/sessions" && body.presetId !== "web-e2e") {
          errors.push("Attempted a non-fixture preset");
          await route.fulfill({ status: 400, json: { ok: false, error: { message: "Only the offline fixture is allowed" } } }); return;
        }
        if (body.method === "command.execute" && body.params.command === "/trust allow" && rejectTrust) {
          rejectTrust = false;
          await route.fulfill({ status: 400, json: { ok: false, error: { message: "Injected trust save failure" } } }); return;
        }
        if (body.method === "command.execute" && body.params.command === "/trust allow" && dropTrustResponse) {
          dropTrustResponse = false;
          assert.ok((await route.fetch()).ok(), "Trust mutation did not reach the real worker");
          await route.abort("failed"); return;
        }
        if (body.method === "turn.abort") {
          if (rejectStop) {
            rejectStop = false;
            await route.fulfill({ status: 503, json: { ok: false, error: { message: "Injected stop failure" } } }); return;
          }
          if (holdStop) await holdStop;
          if (dropStopResponse) {
            dropStopResponse = false;
            assert.ok((await route.fetch()).ok(), "Stop did not reach the real worker");
            await route.abort("failed"); return;
          }
        }
        if (body.method === "interaction.resolve" && rejectApproval) {
          rejectApproval = false;
          await route.fulfill({ status: 503, json: { ok: false, error: { message: "Injected approval failure" } } }); return;
        }
      }
      await route.continue();
    });
    const p = page;
    const input = p.getByRole("textbox", { name: "给代理发送消息", exact: true });
    const submitCount = () => calls.filter(call => ["turn.submit", "turn.steer", "turn.follow-up"].includes(call.body.method)).length;
    const rpc = async <T,>(sessionId: string, method: string): Promise<T> => {
      const response = await p.request.post(`${origin}/api/sessions/${sessionId}/rpc`, { data: { method, params: {} } });
      const body = await response.json(); assert.equal(body.ok, true, JSON.stringify(body)); return body.result;
    };
    const latestSession = async (path: string) => {
      const workspace = host!.workspaces.list().find(workspace => workspace.path === path)!;
      const sessions = await host!.sessions.list(workspace); assert.equal(sessions.length, 1); return sessions[0];
    };
    const reopen = async (path: string) => {
      await p.reload();
      const workspace = host!.workspaces.list().find(workspace => workspace.path === path)!;
      await p.getByRole("combobox", { name: "工作区", exact: true }).selectOption(workspace.id);
      await p.locator(".session-link").first().click();
      await p.locator(".session-header-title button").waitFor();
    };
    const add = async (path: string) => {
      await p.getByRole("combobox", { name: "Agent 模式", exact: true }).selectOption("web-e2e");
      await p.getByRole("button", { name: "添加新的工作区", exact: true }).click();
      const picker = p.getByRole("dialog", { name: "添加工作区", exact: true });
      await until(async () => await picker.getByRole("button", { name: "添加工作区", exact: true }).isEnabled(), "Directory listing did not finish");
      await picker.getByRole("textbox", { name: "文件夹路径" }).fill(path);
      assert.equal(await picker.getByRole("textbox", { name: "文件夹路径" }).inputValue(), path);
      await picker.getByRole("button", { name: "添加工作区", exact: true }).click();
      await until(async () => host!.workspaces.list().some(workspace => workspace.path === path), `Wrong project added: ${path}`);
      await picker.waitFor({ state: "hidden" });
    };
    const trustDialog = p.getByRole("dialog", { name: "是否信任这个项目？", exact: true });
    await p.goto(host.url);

    await scenario("adding a project asks before any turn, cancel preserves the draft and failure never submits", async () => {
      await add(project);
      await trustDialog.waitFor();
      assert.match(await trustDialog.innerText(), new RegExp(project));
      assert.equal(submitCount(), 0);
      const session = await latestSession(project);
      const snapshot = await rpc<SessionSnapshot>(session.id, "session.snapshot");
      assert.equal(snapshot.trust?.decision, "deny"); assert.equal(snapshot.trust?.["explicit?"], false);
      assert.equal(snapshot.events.filter(event => event.type === "step/start").length, 0);
      await trustDialog.getByRole("button", { name: "取消", exact: true }).click();
      await input.fill("请执行离线测试命令"); await input.press("Enter");
      await trustDialog.waitFor();
      await trustDialog.getByRole("button", { name: "取消", exact: true }).click();
      assert.equal(await input.inputValue(), "请执行离线测试命令"); assert.equal(submitCount(), 0);
      await input.press("Enter"); await trustDialog.waitFor(); rejectTrust = true;
      await trustDialog.getByRole("button", { name: "信任并继续", exact: true }).click();
      await trustDialog.getByRole("alert").filter({ hasText: "Injected trust save failure" }).waitFor();
      assert.equal(submitCount(), 0); assert.equal(existsSync(join(project, "approval.txt")), false);
      dropTrustResponse = true;
      await trustDialog.getByRole("button", { name: "信任并继续", exact: true }).click();
      await trustDialog.getByRole("alert").filter({ hasText: "操作结果尚未确认" }).waitFor();
      assert.equal(submitCount(), 0);
      assert.equal((await rpc<SessionSnapshot>(session.id, "session.snapshot")).trust?.decision, "allow");
      const trustWrites = calls.filter(call => call.body.params?.command === "/trust allow").length;
      await trustDialog.getByRole("button", { name: "信任并继续", exact: true }).click();
      await p.getByRole("region", { name: "待确认操作", exact: true }).waitFor();
      assert.equal(calls.filter(call => call.body.params?.command === "/trust allow").length, trustWrites);
      assert.equal(submitCount(), 1);
      assert.equal((await rpc<SessionSnapshot>(session.id, "session.snapshot")).trust?.decision, "allow");
      assert.equal(existsSync(join(project, "approval.txt")), false);
    });

    await scenario("stop works inside approval, handles failure, suppresses repeat clicks and survives refresh", async () => {
      const session = await latestSession(project);
      const approval = p.getByRole("region", { name: "待确认操作", exact: true });
      assert.equal(await p.getByRole("dialog").count(), 0, "Approval must leave the conversation accessible");
      await p.getByRole("tab", { name: "轨迹", exact: true }).click();
      await p.getByRole("tab", { name: "对话", exact: true }).click();
      await input.fill("审批期间保留的草稿");
      await input.press("Enter");
      assert.equal(submitCount(), 1, "Pending approval must block keyboard submission");
      assert.equal(await input.inputValue(), "审批期间保留的草稿");
      await p.setViewportSize({ width: 375, height: 840 });
      const bounds = await approval.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 375 && bounds.y >= 0 && bounds.y + bounds.height <= 840);
      // Chromium may acknowledge viewport changes before the responsive layout commits.
      await until(async () => {
        const buttons = await approval.getByRole("button").all();
        const boxes = await Promise.all(buttons.map(button => button.boundingBox()));
        return boxes.length > 0 && boxes.every(box => box && box.height >= 44);
      }, "Approval buttons must reach the required 44px mobile hit target after resize");
      await p.setViewportSize({ width: 1440, height: 1000 });
      rejectStop = true;
      await approval.getByRole("button", { name: "停止运行", exact: true }).click();
      await approval.getByRole("alert").filter({ hasText: "Injected stop failure" }).waitFor();
      assert.equal((await rpc<SessionSnapshot>(session.id, "session.snapshot")).interactions.length, 1);
      let release!: () => void; holdStop = new Promise<void>(resolve => { release = resolve; });
      const before = calls.filter(call => call.body.method === "turn.abort").length;
      await approval.getByRole("button", { name: "停止运行", exact: true }).click();
      await until(async () => calls.filter(call => call.body.method === "turn.abort").length === before + 1, "Stop was not sent");
      assert.equal(await approval.getByRole("button", { name: "正在停止…", exact: true }).isDisabled(), true);
      assert.equal(await approval.getByRole("button", { name: "仅允许一次", exact: true }).isDisabled(), true);
      release(); holdStop = null;
      await approval.waitFor({ state: "hidden" });
      await until(async () => (await rpc<SessionSnapshot>(session.id, "session.snapshot")).state.phase === "idle", "Runtime did not stop");
      assert.equal((await rpc<SessionSnapshot>(session.id, "session.snapshot")).interactions.length, 0);
      assert.equal(existsSync(join(project, "approval.txt")), false);
      assert.equal(await input.inputValue(), "审批期间保留的草稿");
      await reopen(project);
      await p.getByRole("button", { name: "发送消息", exact: true }).waitFor();
      assert.equal(await p.getByRole("dialog").count(), 0);
      await input.fill("停止后继续对话"); await input.press("Enter");
      await p.locator(".timeline").getByText("Offline continuation complete.", { exact: true }).waitFor();
      assert.equal(submitCount(), 2);
      assert.equal(existsSync(join(project, "approval.txt")), false);
    });

    await scenario("composer menu, IME, multiline draft, focus and responsive geometry remain usable", async () => {
      await input.fill("中文输入");
      await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
      assert.equal(await input.inputValue(), "中文输入"); assert.equal(submitCount(), 2);
      await input.press("Shift+Enter"); assert.match(await input.inputValue(), /\n/);
      await p.getByRole("button", { name: "添加附件与工具", exact: true }).click();
      await p.getByRole("menuitem", { name: "添加附件", exact: true }).waitFor();
      await p.keyboard.press("Escape");
      assert.equal(await p.getByRole("button", { name: "添加附件与工具" }).evaluate(node => node === document.activeElement), true);
      assert.equal(await p.getByRole("menu", { name: "附件与工具" }).count(), 0);
      await input.fill("");
      for (const width of [1440, 768, 414, 375, 320]) {
        await p.setViewportSize({ width, height: 900 });
        assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}`);
        const box = await p.locator(".composer").boundingBox(); assert.ok(box && box.height < 165, JSON.stringify(box));
        for (const selector of [".composer-tools > button", ".send-button", ".permission-trigger", ".model-trigger"]) {
          const rect = await p.locator(selector).boundingBox();
          assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width && rect.height >= 44, `${width}: ${selector} ${JSON.stringify(rect)}`);
        }
        if (artifacts && [1440, 375].includes(width)) {
          await mkdir(artifacts, { recursive: true }); await p.screenshot({ path: join(artifacts, `composer-${width}.png`) });
        }
      }
      await p.setViewportSize({ width: 1440, height: 1000 });
    });

    await scenario("stop cancels a blocking direct-command approval even when no model turn is running", async () => {
      const session = await latestSession(project);
      const endpoint = `${origin}/api/sessions/${session.id}/rpc`;
      const created = await p.request.post(endpoint, { data: { method: "planning.create", params: {
        title: "Direct approval cancellation", steps: [{ id: "check", title: "Check offline data" }],
      } } });
      const plan = await created.json(); assert.equal(plan.ok, true, JSON.stringify(plan));
      const submission = p.request.post(endpoint, { data: { method: "planning.submit", params: { expected_revision: plan.result.plan.revision } } });
      const approval = p.getByRole("region", { name: "待确认操作", exact: true }).filter({ hasText: "Approve plan: Direct approval cancellation" });
      await approval.waitFor();
      dropStopResponse = true;
      const stops = calls.filter(call => call.body.method === "turn.abort").length;
      await approval.getByRole("button", { name: "停止运行", exact: true }).click();
      await approval.waitFor({ state: "hidden" });
      const result = await (await submission).json(); assert.equal(result.ok, false);
      assert.match(result.error.message, /cancelled/i);
      const snapshot = await rpc<SessionSnapshot>(session.id, "session.snapshot");
      assert.equal(snapshot.state.phase, "idle"); assert.equal(snapshot.interactions.length, 0);
      const state = await rpc<{ plan: { status: string } }>(session.id, "planning.show");
      assert.equal(state.plan.status, "paused");
      assert.equal(existsSync(join(project, "approval.txt")), false);
      const reconcile = p.getByRole("button", { name: "核对结果", exact: true });
      await reconcile.click();
      await reconcile.waitFor({ state: "hidden" });
      assert.equal(calls.filter(call => call.body.method === "turn.abort").length, stops + 1);
    });

    await scenario("trust inheritance is respected and an approved real write succeeds only after approval", async () => {
      const child = join(project, "child"); await mkdir(child);
      await p.locator(".new-session").click(); await add(child);
      await until(async () => (await host!.sessions.listAll()).some(session => session.workspaceId === host!.workspaces.list().find(workspace => workspace.path === child)?.id), "Child draft missing");
      await until(async () => await input.isEnabled(), "Child trust check did not finish");
      assert.equal(await trustDialog.count(), 0);
      const session = await latestSession(child);
      const status = await rpc<SessionSnapshot>(session.id, "session.snapshot");
      assert.equal(status.trust?.decision, "allow"); assert.equal(status.trust?.["matched-root"], project);
      await input.fill("允许测试写入"); await input.press("Enter");
      const approval = p.getByRole("region", { name: "待确认操作", exact: true }); await approval.waitFor();
      assert.equal(existsSync(join(child, "approval.txt")), false);
      await input.fill("确认操作后继续编辑的草稿");
      rejectApproval = true;
      await approval.getByRole("button", { name: "仅允许一次", exact: true }).click();
      await approval.getByRole("alert").filter({ hasText: "Injected approval failure" }).waitFor();
      assert.equal((await rpc<SessionSnapshot>(session.id, "session.snapshot")).interactions.length, 1);
      assert.equal(existsSync(join(child, "approval.txt")), false);
      await approval.getByRole("button", { name: "仅允许一次", exact: true }).click();
      await p.locator(".timeline").getByText("Offline continuation complete.", { exact: true }).waitFor();
      assert.equal(await readFile(join(child, "approval.txt"), "utf8"), "approved by browser");
      assert.equal(existsSync(join(project, "approval.txt")), false);
      assert.equal(await input.inputValue(), "确认操作后继续编辑的草稿");
    });

    await scenario("declining trust persists, stays visible and does not trust a sibling project", async () => {
      const restricted = join(root, "restricted"); await mkdir(restricted);
      await p.locator(".new-session").click(); await add(restricted); await trustDialog.waitFor();
      await trustDialog.getByRole("button", { name: "保持受限", exact: true }).click();
      await trustDialog.waitFor({ state: "hidden" });
      await p.locator(".composer-trust").waitFor();
      const session = await latestSession(restricted);
      const snapshot = await rpc<SessionSnapshot>(session.id, "session.snapshot");
      assert.equal(snapshot.trust?.decision, "deny"); assert.equal(snapshot.trust?.["explicit?"], true);
      await input.fill("受限模式执行测试"); await input.press("Enter");
      await p.locator(".timeline").getByText("Offline continuation complete.", { exact: true }).waitFor();
      assert.equal(existsSync(join(restricted, "approval.txt")), false);
      assert.equal(await trustDialog.count(), 0);
      const final = await rpc<SessionSnapshot>(session.id, "session.snapshot");
      assert.ok(final.events.some(event => event.type === "tool/result" && JSON.stringify(event.data).includes("requires a trusted project")));
      await reopen(restricted); await p.locator(".composer-trust").waitFor();
      assert.equal(await trustDialog.count(), 0);
    });

    await scenario("a finishing run cannot unlock a new submission while its stop request is still in flight", async () => {
      const raceProject = join(project, "finish-during-stop"); await mkdir(raceProject);
      await p.locator(".new-session").click(); await add(raceProject);
      await until(async () => await input.isEnabled(), "Race project did not finish loading");
      await input.fill("等待审批时结束原任务"); await input.press("Enter");
      const approval = p.getByRole("region", { name: "待确认操作", exact: true }); await approval.waitFor();
      const session = await latestSession(raceProject);
      const snapshot = await rpc<SessionSnapshot>(session.id, "session.snapshot");
      const before = submitCount();
      let release!: () => void; holdStop = new Promise<void>(resolve => { release = resolve; });
      try {
        await approval.getByRole("button", { name: "停止运行", exact: true }).click();
        // Another client resolves the old turn while the browser's abort is delayed.
        const response = await p.request.post(`${origin}/api/sessions/${session.id}/rpc`, { data: {
          method: "interaction.resolve", params: { id: snapshot.interactions[0].id, decision: "deny" },
        } });
        assert.equal((await response.json()).ok, true);
        await approval.waitFor({ state: "hidden" });
        await p.locator(".timeline").getByText("Offline continuation complete.", { exact: true }).waitFor();
        await until(async () => (await rpc<SessionSnapshot>(session.id, "session.snapshot")).state.phase === "idle", "Original turn did not finish");
        await input.fill("停止确认后再发送的新任务"); await input.press("Enter");
        assert.equal(submitCount(), before, "New work was sent before the earlier abort completed");
        assert.equal(await input.inputValue(), "停止确认后再发送的新任务");
        assert.equal(await p.getByRole("button", { name: "正在停止", exact: true }).isDisabled(), true);
      } finally { release(); holdStop = null; }
      await p.getByRole("button", { name: "发送消息", exact: true }).waitFor();
      await input.press("Enter");
      await p.locator(".timeline").getByText("Offline follow-up complete.", { exact: true }).waitFor();
      assert.equal(submitCount(), before + 1);
      assert.equal(existsSync(join(raceProject, "approval.txt")), false);
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ realWebE2E: "passed", externalModelCalls: 0, assertions: "browser + runtime snapshot + persisted trust + actual filesystem" }));
  } catch (error) {
    if (artifacts && page) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined); }
    throw error;
  } finally {
    await browser?.close();
    await host?.close();
    if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, "exit"), timer = setTimeout(() => daemon?.kill("SIGKILL"), 3000);
      await exited; clearTimeout(timer);
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
