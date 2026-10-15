import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodingCandidates, type CandidateWriter, type CodingCandidateConfig } from "./coding-candidates.js";
import { WorkspaceRegistry } from "./workspaces.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "qi-coding-test-")));
  const source = join(root, "source"), controller = join(root, "controller"), verifier = join(root, "verifier");
  await mkdir(join(source, "src"), { recursive: true }); await mkdir(controller); await mkdir(verifier);
  await writeFile(join(source, "src/value.mjs"), "export const value=1;\n");
  git(source, "init", "-b", "main"); git(source, "add", ".");
  git(source, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base");
  const sha = git(source, "rev-parse", "HEAD");
  for (const file of ["maintenance/lib", "maintenance/checks.json", "maintenance/policy.json", "evals/lib"]) {
    await cp(file, join(controller, file), { recursive: true });
  }
  git(controller, "init", "-b", "main"); git(controller, "add", ".");
  git(controller, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "trusted-fixture");
  const controllerSha = git(controller, "rev-parse", "HEAD");
  await writeFile(join(root, "profile.edn"), "{:plugins []}");
  await writeFile(join(verifier, "acceptance.mjs"), "import test from 'node:test';import assert from 'node:assert/strict';import {value} from '/work/src/value.mjs';test('value repaired',()=>assert.equal(value,2));");
  const workspaces = new WorkspaceRegistry(join(root, "web")); await workspaces.load(source);
  const workspace = workspaces.list()[0];
  const contract = join(root, "contract.json");
  await writeFile(contract, JSON.stringify({ schema_version: 1, task_id: "fixture", goal: "repair value", kind: "bug", base_sha: sha,
    image: "sha256:" + "a".repeat(64), profile_path: join(root, "profile.edn"), verifier_dir: verifier,
    allowed_files: ["src/value.mjs"], checks: [{ id: "parse", argv: ["node", "--check", "src/value.mjs"], timeout_seconds: 10 }],
    acceptance: { file: "acceptance.mjs", tests: ["value repaired"] } }));
  const config: CodingCandidateConfig = { schema_version: 1, controller_path: controller, controller_sha: controllerSha,
    directory: join(root, "candidates"), contracts: { [workspace.id]: contract } };
  let writers: CandidateWriter[] | Error = [];
  const inspect = async () => { if (writers instanceof Error) throw writers; return writers; };
  const manager = new CodingCandidates(config, workspaces, inspect); await manager.initialize();
  const input = { workspace_id: workspace.id, base_sha: sha, command_id: "coding-command-1" };
  return { root, source, controller, config, contract, manager, workspaces, inspect, input,
    setWriters: (value: CandidateWriter[] | Error) => { writers = value; },
    close: () => rm(root, { recursive: true, force: true }) };
}

test("candidate ownership survives two controllers, duplicate commands and a lost reply", async () => {
  const f = await fixture();
  try {
    const other = new CodingCandidates(f.config, f.workspaces, f.inspect); await other.initialize();
    const results = await Promise.allSettled([f.manager.begin(f.input), other.begin({ ...f.input, command_id: "competing-command" })]);
    assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
    const record = (results.find(row => row.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<CodingCandidates["begin"]>>>).value;
    const original = record.command_id === f.input.command_id ? f.input : { ...f.input, command_id: "competing-command" };
    assert.equal((await other.begin({ command_id: original.command_id, base_sha: original.base_sha, workspace_id: original.workspace_id })).candidate_id, record.candidate_id);
    const path = join(f.config.directory, record.candidate_id + ".json");
    await writeFile(path, JSON.stringify({ ...record, status: "unknown", reason: "reply-lost" }));
    assert.equal((await other.begin(original)).status, "unknown");
    assert.equal((await other.reconcile(record.candidate_id)).status, "ready");
    assert.equal(git(f.source, "worktree", "list", "--porcelain").split("worktree ").length - 1, 2);
  } finally { await f.close(); }
});

test("a live or unknown writer retains ownership across host restart", async () => {
  const f = await fixture();
  try {
    const record = await f.manager.begin(f.input);
    await f.manager.claim(record.candidate_workspace_id, "writer-session-1");
    await assert.rejects(() => f.manager.claim(record.candidate_workspace_id, "writer-session-2"), /another writer/);
    const restarted = new CodingCandidates(f.config, f.workspaces, f.inspect); await restarted.initialize();
    f.setWriters([{ agent_id: "native-root", resident: true }]);
    await assert.rejects(() => restarted.close(record.candidate_id), /still resident/);
    f.setWriters(new Error("daemon outcome unknown"));
    await assert.rejects(() => restarted.close(record.candidate_id), /unknown/);
    assert.equal((await restarted.status(record.candidate_id)).writers, null);
    f.setWriters([]);
    assert.equal((await restarted.close(record.candidate_id)).status, "closed");
    await assert.rejects(() => restarted.claim(record.candidate_workspace_id, "writer-session-1"), /not writable/);
    const next = await restarted.begin({ ...f.input, command_id: "next-candidate-command" });
    assert.notEqual(next.candidate_id, record.candidate_id);
    await assert.rejects(() => restarted.claim(record.candidate_workspace_id, "writer-session-1"), /not writable/);
  } finally { await f.close(); }
});

test("changed contracts, base SHA, controller and browser overrides cannot reuse admission", async () => {
  const f = await fixture();
  try {
    await f.manager.begin(f.input);
    await assert.rejects(() => f.manager.begin({ ...f.input, base_sha: "a".repeat(40) }), /frozen host contract/);
    await assert.rejects(() => f.manager.begin({ ...f.input, profile_path: "/tmp/override" }), /Explicit/);
    const contract = JSON.parse(await readFile(f.contract, "utf8")); contract.goal = "changed";
    await writeFile(f.contract, JSON.stringify(contract));
    await assert.rejects(() => f.manager.begin(f.input), /different parameters or contract/);
    await writeFile(join(f.controller, "unreviewed.mjs"), "new rule");
    await assert.rejects(() => f.manager.begin(f.input), /Pinned candidate controller changed/);
  } finally { await f.close(); }
});

test("candidate state cannot be placed inside an original checkout", async () => {
  const f = await fixture();
  try {
    const destination = join(f.source, "must-not-create");
    const manager = new CodingCandidates({ ...f.config, directory: destination }, f.workspaces, f.inspect);
    await assert.rejects(() => manager.initialize(), /overlaps/);
    await assert.rejects(() => stat(destination), { code: "ENOENT" });
  } finally { await f.close(); }
});
