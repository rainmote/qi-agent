import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionCatalog } from "./session-catalog.js";
import type { Workspace } from "./types.js";

function line(type: string, data: Record<string, unknown>, at = "2026-10-02T00:00:00Z"): string {
  return `${JSON.stringify({ type, at, data })}\n`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "qi-agent-catalog-test-"));
  const workspace: Workspace = { id: "catalog-workspace", name: "Fixture", path: root, addedAt: "" };
  const directory = join(root, ".qi-agent", "sessions");
  await mkdir(directory, { recursive: true });
  return { root, workspace, directory, path: join(directory, "session.jsonl") };
}

test("catalog incrementally completes partial UTF-8 lines and counts an unterminated event once", async () => {
  const value = await fixture();
  const catalog = new SessionCatalog();
  try {
    const initial = line("session/start", { session_id: "partial" });
    const name = Buffer.from(line("session/name", { name: "恢复标题" }));
    const split = name.indexOf(Buffer.from("恢")) + 1;
    await writeFile(value.path, Buffer.concat([Buffer.from(initial), name.subarray(0, split)]));
    const first = (await catalog.list(value.workspace))[0];
    assert.equal(first.id, "partial");
    assert.equal(first.eventCount, 1);
    assert.equal(first.name, null);
    await appendFile(value.path, name.subarray(split, name.length - 1));
    const second = (await catalog.list(value.workspace))[0];
    assert.equal(second.name, "恢复标题");
    assert.equal(second.eventCount, 2);
    await appendFile(value.path, `\n${line("message", { content: "one" })}`);
    const third = (await catalog.list(value.workspace))[0];
    assert.equal(third.eventCount, 3);
    assert.equal(third.messageCount, 1);
    const stats = catalog.statistics;
    await catalog.list(value.workspace);
    assert.equal(catalog.statistics.bytesRead, stats.bytesRead);
    assert.equal(catalog.statistics.parsedLines, stats.parsedLines);
    assert.equal(catalog.statistics.fullReads, 1);
    assert.equal(catalog.statistics.incrementalReads, 2);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("catalog invalidates truncated, rewritten, replaced, renamed and deleted logs", async () => {
  const value = await fixture();
  const catalog = new SessionCatalog();
  try {
    const original = line("session/start", { session_id: "original" })
      + line("session/name", { name: "Original" }) + line("message", { content: "old" });
    await writeFile(value.path, original);
    assert.equal((await catalog.list(value.workspace))[0].messageCount, 1);
    await truncate(value.path, 0);
    assert.deepEqual(await catalog.list(value.workspace), []);
    await appendFile(value.path, line("session/start", { session_id: "regrown" }));
    assert.equal((await catalog.list(value.workspace))[0].id, "regrown");
    // A truncate and regrow completed entirely between polls must also reset
    // the summary, even though the inode did not change and size increased.
    await writeFile(value.path, line("session/start", { session_id: "rewritten" })
      + line("session/name", { name: "Different history with a much longer title" }));
    const rewritten = (await catalog.list(value.workspace))[0];
    assert.equal(rewritten.id, "rewritten");
    assert.equal(rewritten.eventCount, 2);
    const replacement = join(value.directory, "replacement.tmp");
    await writeFile(replacement, line("session/start", { session_id: "replacement" }));
    await rename(replacement, value.path);
    assert.equal((await catalog.list(value.workspace))[0].id, "replacement");
    assert.equal(await catalog.find("original", [value.workspace]), null);
    const renamed = join(value.directory, "renamed.jsonl");
    await rename(value.path, renamed);
    assert.equal((await catalog.find("replacement", [value.workspace]))?.path, renamed);
    const archive = join(value.root, ".qi-agent", "archive", "sessions");
    await mkdir(archive, { recursive: true });
    await rename(renamed, join(archive, "renamed.jsonl"));
    assert.deepEqual(await catalog.list(value.workspace), []);
    assert.equal(await catalog.find("replacement", [value.workspace]), null);
    await writeFile(value.path, line("session/start", { session_id: "deleted" }));
    await catalog.list(value.workspace);
    await rm(value.path);
    assert.equal(await catalog.find("deleted", [value.workspace]), null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("catalog refreshes same-size edits, skips invalid lines, and excludes linked logs", async () => {
  const value = await fixture();
  const catalog = new SessionCatalog();
  try {
    const start = line("session/start", { session_id: "same-size" });
    await writeFile(value.path, `${start}null\n{bad json}\n${line("session/name", { name: "Before" })}`);
    assert.equal((await catalog.list(value.workspace))[0].eventCount, 2);
    await writeFile(value.path, `${start}null\n{bad json}\n${line("session/name", { name: "After!" })}`);
    assert.equal((await catalog.list(value.workspace))[0].name, "After!");
    await symlink(value.path, join(value.directory, "linked.jsonl"));
    assert.equal((await catalog.list(value.workspace)).length, 1);
    assert.equal(await catalog.describe(join(value.directory, "linked.jsonl"), value.workspace.id), null);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("catalog handles a message spanning many read chunks and a partial following record", async () => {
  const value = await fixture();
  const catalog = new SessionCatalog();
  try {
    const message = line("message", { content: "内容".repeat(100_000) });
    const following = line("session/label", { label: "large" });
    const start = line("session/start", { session_id: "large" });
    await writeFile(value.path, start + message + following.slice(0, 12));
    const first = (await catalog.list(value.workspace))[0];
    assert.equal(first.eventCount, 2);
    assert.equal(first.messageCount, 1);
    assert.equal(first.label, null);
    await appendFile(value.path, following.slice(12));
    const second = (await catalog.list(value.workspace))[0];
    assert.equal(second.eventCount, 3);
    assert.equal(second.messageCount, 1);
    assert.equal(second.label, "large");
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("catalog discovers legacy sessions and never resolves IDs outside current allowed workspaces", async () => {
  const value = await fixture();
  const catalog = new SessionCatalog();
  try {
    const legacy = join(value.root, ".bb-agent", "sessions");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "legacy.jsonl"), line("session/start", { session_id: "legacy" }));
    assert.equal((await catalog.list(value.workspace))[0].id, "legacy");
    assert.equal(await catalog.find("legacy", []), null);
    assert.match((await catalog.find("legacy", [value.workspace]))!.path, /\.bb-agent/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("catalog excludes linked session directories and invalidates a cached path if its parent becomes linked", async () => {
  const value = await fixture();
  const catalog = new SessionCatalog();
  try {
    await writeFile(value.path, line("session/start", { session_id: "inside" }));
    await catalog.list(value.workspace);
    const external = join(value.root, "outside-sessions");
    await mkdir(external);
    await writeFile(join(external, "session.jsonl"), line("session/start", { session_id: "inside" }));
    await rm(value.directory, { recursive: true });
    await symlink(external, value.directory, "dir");
    const before = catalog.statistics.bytesRead;
    assert.equal(await catalog.find("inside", [value.workspace]), null);
    assert.deepEqual(await catalog.list(value.workspace), []);
    assert.equal(catalog.statistics.bytesRead, before, "Linked parent content must not be read");
    await rm(join(value.root, ".qi-agent"), { recursive: true });
    const outsideRoot = join(value.root, "outside-root");
    await mkdir(join(outsideRoot, "sessions"), { recursive: true });
    await writeFile(join(outsideRoot, "sessions", "other.jsonl"),
      line("session/start", { session_id: "other" }));
    await symlink(outsideRoot, join(value.root, ".qi-agent"), "dir");
    assert.deepEqual(await catalog.list(value.workspace), []);
    assert.equal(catalog.statistics.bytesRead, before);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("catalog coalesces concurrent scans, bounds I/O, and measures warm-list and append work", async (context) => {
  const value = await fixture();
  const catalog = new SessionCatalog(4);
  try {
    const files = 24;
    const messages = 200;
    let totalBytes = 0;
    for (let index = 0; index < files; index += 1) {
      const content = line("session/start", { session_id: `session-${index}` })
        + Array.from({ length: messages }, (_, message) =>
          line("message", { content: `Message ${message} ${"x".repeat(256)}` })).join("");
      totalBytes += Buffer.byteLength(content);
      await writeFile(join(value.directory, `${index}.jsonl`), content);
    }
    const lists = await Promise.all(Array.from({ length: 12 }, () => catalog.list(value.workspace)));
    assert.ok(lists.every((list) => list.length === files));
    const cold = catalog.statistics;
    assert.equal(cold.directoryReads, 2);
    assert.equal(cold.fullReads, files);
    assert.equal(cold.parsedLines, files * (messages + 1));
    assert.equal(cold.bytesRead, totalBytes);
    assert.equal(cold.peakConcurrentReads, 4);
    // Callers receive separate objects and cannot corrupt the cache.
    lists[0][0].name = "mutated by caller";
    assert.notEqual(lists[1][0].name, "mutated by caller");
    await Promise.all(Array.from({ length: 8 }, () => catalog.list(value.workspace)));
    const warm = catalog.statistics;
    assert.equal(warm.bytesRead, cold.bytesRead);
    assert.equal(warm.parsedLines, cold.parsedLines);
    const appended = line("message", { content: "Appended message" }, "2026-10-02T00:00:01Z");
    await appendFile(join(value.directory, "0.jsonl"), appended);
    const updated = await catalog.find("session-0", [value.workspace]);
    assert.equal(updated?.messageCount, messages + 1);
    assert.equal(updated?.updatedAt, "2026-10-02T00:00:01Z");
    const final = catalog.statistics;
    assert.equal(final.directoryReads, warm.directoryReads);
    assert.equal(final.parsedLines - warm.parsedLines, 1);
    assert.equal(final.bytesRead - warm.bytesRead, 2048 + Buffer.byteLength(appended));
    assert.equal(final.incrementalReads, 1);
    assert.ok(final.peakConcurrentReads <= catalog.concurrency);
    context.diagnostic(JSON.stringify({
      sample: `${files} files, ${files * (messages + 1)} events`,
      coldReadBytes: cold.bytesRead, warmReadBytes: warm.bytesRead - cold.bytesRead,
      appendReadBytes: final.bytesRead - warm.bytesRead,
      appendParsedLines: final.parsedLines - warm.parsedLines,
      peakConcurrentIO: final.peakConcurrentReads,
    }));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
