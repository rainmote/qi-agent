import assert from "node:assert/strict";
import test from "node:test";
import { terminalOutputPending } from "./TerminalPanel";

test("closed PTY drains every final chunk while controls remain closed", () => {
  assert.equal(terminalOutputPending({ status: "running" }), true);
  let cursor = 0, reads = 0;
  let state = { status: "closed", has_more: true };
  while (terminalOutputPending(state)) {
    cursor = Math.min(200000, cursor + 65536); reads++;
    state = { status: "closed", has_more: cursor < 200000 };
    assert.equal(state.status, "closed");
  }
  assert.equal(reads, 4); assert.equal(cursor, 200000);
  assert.equal(terminalOutputPending({ status: "unknown", has_more: true }), false);
  assert.equal(terminalOutputPending({ status: "running", uncertain: true }), false);
  assert.equal(terminalOutputPending(undefined), false);
});

test("an early closed status cannot discard the final late read", () => {
  const statusBeforeLastReadArrives = { status: "closed", has_more: false, end: 200000 };
  assert.equal(terminalOutputPending(statusBeforeLastReadArrives, 131072), true);
  assert.equal(terminalOutputPending(statusBeforeLastReadArrives, 200000), false);
});
