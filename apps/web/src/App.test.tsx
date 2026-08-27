import assert from "node:assert/strict";
import test from "node:test";
import { commandOutputNotice, matchingCommands } from "./App";

const commands = [
  { name: "commands", description: "List commands" },
  { name: "compact", description: "Compact history" },
  { name: "model", description: "Select model" },
];

test("slash suggestions open while typing and close after command selection", () => {
  assert.deepEqual(matchingCommands(commands, "/").map((entry) => entry.name),
    ["commands", "compact", "model"]);
  assert.deepEqual(matchingCommands(commands, "/com").map((entry) => entry.name),
    ["commands", "compact"]);
  assert.deepEqual(matchingCommands(commands, "/commands "), []);
  assert.deepEqual(matchingCommands(commands, "hello"), []);
});

test("large command results are summarized for the toast", () => {
  const result = Array.from({ length: 15 }, (_, index) => ({ name: `command-${index}` }));
  const notice = commandOutputNotice(result);
  assert.match(notice, /^可用命令：\/command-0/);
  assert.match(notice, /等 15 个$/);
  assert.ok(notice.length < 420);
});
