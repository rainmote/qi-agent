import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopDirectory } from "./desktop-directory";

test("native directory cancellation and malformed events cannot prefill a project", () => {
  for (const path of [null, undefined, {}, "relative/path", "", "/tmp/bad\npath", "/".repeat(4097)]) assert.equal(desktopDirectory(path), null);
  assert.equal(desktopDirectory("/tmp/Project with 中文"), "/tmp/Project with 中文");
  assert.equal(desktopDirectory("C:\\Project"), "C:\\Project");
});
