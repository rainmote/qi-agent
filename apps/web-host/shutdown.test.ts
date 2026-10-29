import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { waitForDaemonShutdown } from "./shutdown.js";

const id = "00000000-0000-4000-8000-000000000001";
async function fixture() {
  const runtime = await mkdtemp(join(tmpdir(), "qi-shutdown-"));
  const path = join(runtime, `shutdown-${id}.json`);
  const accepted = { shutting_down: true, preserve_sessions: true, shutdown_id: id, receipt_path: path };
  const receipt = { schema_version: 1, shutdown_id: id, preserve_sessions: true, ok: true, errors: [] };
  return { runtime, path, accepted, receipt, cleanup: () => rm(runtime, { recursive: true, force: true }) };
}

test("shutdown acknowledgement alone cannot prove cleanup", async () => {
  const f = await fixture();
  try { await assert.rejects(waitForDaemonShutdown(f.runtime, f.accepted, 30), /UNKNOWN/); }
  finally { await f.cleanup(); }
});

test("matching shutdown receipt still waits for the old daemon socket to retire", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, JSON.stringify(f.receipt));
    await writeFile(join(f.runtime, "daemon.sock"), "old socket fixture");
    await assert.rejects(waitForDaemonShutdown(f.runtime, f.accepted, 30), /UNKNOWN/);
    await rm(join(f.runtime, "daemon.sock"));
    await waitForDaemonShutdown(f.runtime, f.accepted, 30);
  } finally { await f.cleanup(); }
});

test("shutdown proof rejects foreign identity, incomplete cleanup and arbitrary paths", async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, JSON.stringify({ ...f.receipt, shutdown_id: "another-instance" }));
    await assert.rejects(waitForDaemonShutdown(f.runtime, f.accepted, 30), /identity mismatch/);
    await writeFile(f.path, JSON.stringify({ ...f.receipt, ok: false, errors: ["worker remains"] }));
    await assert.rejects(waitForDaemonShutdown(f.runtime, f.accepted, 30), /incomplete/);
    await assert.rejects(waitForDaemonShutdown(f.runtime, { ...f.accepted, receipt_path: "/outside.json" }, 30), /identity mismatch/);
    await assert.rejects(waitForDaemonShutdown(f.runtime, { ...f.accepted, preserve_sessions: false }, 30), /UNKNOWN/);
  } finally { await f.cleanup(); }
});
