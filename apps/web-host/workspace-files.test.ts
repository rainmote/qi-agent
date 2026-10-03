import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistry } from "./workspaces.js";
import { MAX_ATTACHMENT_BYTES, WorkspaceFiles } from "./workspace-files.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "qi-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace"); await mkdir(workspace);
  const registry = new WorkspaceRegistry(join(root, "state")); await registry.load();
  const entry = await registry.add(workspace);
  const second = join(root, "second"); await mkdir(second); const other = await registry.add(second);
  const files = new WorkspaceFiles(registry, { attachmentDirectory: join(root, "uploads") });
  return { root, workspace, registry, id: entry.id, otherId: other.id, files };
}

test("file tree and reads stay inside an allowlisted workspace and hide sensitive directories", async t => {
  const { root, workspace, registry, id, files } = await fixture(t);
  await mkdir(join(workspace, "src")); await writeFile(join(workspace, "src", "hello.ts"), "export const n = 1;\n");
  await writeFile(join(workspace, ".env"), "fixture-private"); await writeFile(join(workspace, "credentials.json"), "fixture-private");
  await mkdir(join(workspace, "node_modules")); await writeFile(join(root, "outside.txt"), "outside");
  await symlink(root, join(workspace, "escape"));
  assert.deepEqual((await files.list(id)).entries.map(entry => entry.name), ["src"]);
  assert.equal((await files.preview(id, "src/hello.ts")).text, "export const n = 1;\n");
  assert.deepEqual((await files.search(id, "hello")).entries.map(entry => entry.path), ["src/hello.ts"]);
  for (const path of ["../outside.txt", "/etc/passwd", "escape/outside.txt", ".env", "credentials.json", "src/../src/hello.ts"]) {
    await assert.rejects(files.preview(id, path));
  }
  await registry.remove(id); await assert.rejects(files.list(id), /allowlisted/);
});

test("uploads use private ID storage, reject invalid images and preserve workspace ownership", async t => {
  const { workspace, id, otherId, files } = await fixture(t);
  await writeFile(join(workspace, "report.txt"), "existing");
  const input = { name: "report.txt", mime: "image/png", base64: Buffer.from("uploaded text").toString("base64") };
  const ref = await files.upload(id, input);
  assert.equal(ref.mime, "text/plain"); assert.equal(await readFile(join(workspace, "report.txt"), "utf8"), "existing");
  const served = await files.attachment(id, ref.id); assert.equal(served.body.toString(), "uploaded text");
  assert.equal((await lstat(files.attachmentDirectory)).mode & 0o077, 0);
  assert.equal((await lstat(join(files.attachmentDirectory, `${ref.id}.bin`))).mode & 0o077, 0);
  await assert.rejects(files.attachment(otherId, ref.id), /belong/);
  await assert.rejects(files.upload(id, { ...input, name: "../report.txt" }), /name/);
  await assert.rejects(files.upload(id, { ...input, name: "not-image.png" }), /format/);
  await assert.rejects(files.upload(id, { ...input, base64: "bad!?" }), /Invalid/);
  await assert.rejects(files.upload(id, { ...input, base64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString("base64") }), /oversized/);
  await writeFile(join(files.attachmentDirectory, `${ref.id}.bin`), "tampered");
  await assert.rejects(files.attachment(id, ref.id), /integrity/);
});

test("an allowlisted workspace root cannot be replaced by a symbolic link to another directory", async t => {
  const { root, workspace, id, files } = await fixture(t);
  const outside = join(root, "outside-workspace");
  await mkdir(outside); await writeFile(join(outside, "private.txt"), "outside fixture data");
  await rename(workspace, join(root, "original-workspace"));
  await symlink(outside, workspace);
  await assert.rejects(files.list(id), /changed|symbolic|replaced/i);
  await assert.rejects(files.preview(id, "private.txt"), /changed|symbolic|replaced/i);
  await assert.rejects(files.content(id, "private.txt"), /changed|symbolic|replaced/i);
});

test("upload references cannot follow symlinks or relaxed permissions", async t => {
  const { root, id, files } = await fixture(t);
  const ref = await files.upload(id, { name: "note.txt", mime: "text/plain", base64: Buffer.from("safe").toString("base64") });
  const stored = join(files.attachmentDirectory, `${ref.id}.bin`);
  await chmod(stored, 0o644); await assert.rejects(files.attachment(id, ref.id), /private resource/);
  await rm(stored); await writeFile(join(root, "outside"), "safe"); await symlink(join(root, "outside"), stored);
  await assert.rejects(files.attachment(id, ref.id));
});

test("HTML responses cannot execute same-origin script or submit forms; Office support is explicit", async t => {
  const { workspace, id, files } = await fixture(t);
  await writeFile(join(workspace, "preview.html"), "<script>fetch('/api/bootstrap')</script><h1>Report</h1>");
  const preview = await files.preview(id, "preview.html"); assert.equal(preview.kind, "html");
  const served = await files.content(id, "preview.html");
  assert.match(served.headers["Content-Security-Policy"], /^sandbox;/); assert.match(served.headers["Content-Security-Policy"], /default-src 'none'/);
  assert.equal(served.headers["X-Content-Type-Options"], "nosniff");
  await writeFile(join(workspace, "report.docx"), Buffer.from([80, 75, 0, 1]));
  const office = await files.preview(id, "report.docx"); assert.equal(office.kind, "unsupported"); assert.match(office.notice || "", /未执行格式转换/);
  assert.match((await files.content(id, "report.docx")).headers["Content-Disposition"], /^attachment;/);
});

test("turn snapshots report added, modified and deleted text without exposing secrets; finish retries are idempotent", async t => {
  const { workspace, id, files } = await fixture(t);
  await writeFile(join(workspace, "change.txt"), "before\n"); await writeFile(join(workspace, "delete.txt"), "gone\n");
  await writeFile(join(workspace, ".env"), "private before");
  await files.beginTurn(id, "turn-fixture-001");
  await files.beginTurn(id, "turn-fixture-001");
  await writeFile(join(workspace, "change.txt"), "after\n"); await writeFile(join(workspace, "add.txt"), "new\n"); await rm(join(workspace, "delete.txt"));
  await writeFile(join(workspace, ".env"), "private after");
  const changed = await files.finishTurn(id, "turn-fixture-001", { aborted: true });
  assert.deepEqual(changed.files.map(file => [file.path, file.status]).sort(), [["add.txt", "added"], ["change.txt", "modified"], ["delete.txt", "deleted"]]);
  assert.equal(changed.partial, true); assert.match(changed.files.find(file => file.path === "change.txt")!.diff, /-before\n\+after/);
  assert.doesNotMatch(JSON.stringify(changed), /private before|private after/);
  assert.deepEqual(await files.finishTurn(id, "turn-fixture-001"), changed);
  assert.deepEqual(await files.changes(id, "turn-fixture-001"), changed);
});

test("startup recovery marks unfinished snapshots partial without pretending the agent stopped", async t => {
  const { workspace, id, files } = await fixture(t);
  const { snapshotTurnId } = await import("./turn-files.js"), turnId = snapshotTurnId("session-recovered", "command-recovered");
  await writeFile(join(workspace, "change.txt"), "before");
  await files.beginTurn(id, turnId, "session-recovered");
  await writeFile(join(workspace, "change.txt"), "after");
  await files.recoverPending();
  const recovered = await files.sessionChanges(id, "session-recovered");
  assert.equal(recovered?.partial, true); assert.match(recovered?.notice || "", /代理可能仍在运行/);
  assert.equal(await files.beginTurn(id, turnId, "session-recovered"), false);
});
