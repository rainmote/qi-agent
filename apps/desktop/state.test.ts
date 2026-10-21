import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSavedPort, rememberPort, savedPort } from "./state.js";

test("desktop keeps the origin across restart and fails closed on damaged state", async () => {
  const root = await mkdtemp(join(tmpdir(), "qi-desktop-port-"));
  const path = join(root, "port.json");
  try {
    assert.equal(await savedPort(path), 0);
    await rememberPort(path, 43127);
    assert.equal(await savedPort(path), 43127);
    await chmod(path, 0o644);
    await assert.rejects(savedPort(path), /private regular file/);
    await chmod(path, 0o600);
    await writeFile(path, "{invalid");
    await assert.rejects(savedPort(path));
    await rm(path);
    await symlink(join(root, "missing"), path);
    await assert.rejects(savedPort(path), /private regular file/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("desktop rejects ports outside its persistent unprivileged origin", () => {
  for (const value of [null, {}, { port: 0 }, { port: 80 }, { port: 65536 }, { port: "43127" }, { port: 43127.5 }]) {
    assert.throws(() => parseSavedPort(value));
  }
});
