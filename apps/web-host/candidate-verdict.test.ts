import assert from "node:assert/strict";
import test from "node:test";
import { candidateVerdict } from "./candidate-verdict.js";

function fixture(): any {
  const fingerprint = "a".repeat(64), controller = "b".repeat(40), image = "sha256:" + "c".repeat(64);
  const argv = ["node", "--test", "--test-reporter=tap", "/acceptance/acceptance.mjs"];
  const output = "d".repeat(64);
  return { record: { candidate_id: "coding-" + "e".repeat(32), base_sha: "f".repeat(40), controller_sha: controller,
      verification: { source_fingerprint: fingerprint } },
    state: { status: "review_ready", base_sha: "f".repeat(40), controller_sha: controller,
      profile_hash: fingerprint, verifier_hash: fingerprint, material_hash: fingerprint, contract_hash: fingerprint,
      candidate_sha: "1".repeat(40), checks: [{ id: "acceptance", phase: "candidate", status: "PASS", argv, image,
        exit_code: 0, tap: { complete: true, passed: true }, output: { sha256: output } }] },
    task: { image, checks: [], acceptance: { file: "acceptance.mjs" } },
    raw: new Map([[output, { exit_code: 0, stdout: "# tests 1\n# pass 1\n# fail 0\n# skipped 0\n" }]]),
    currentFingerprint: fingerprint, treeMatches: true, running: false };
}

test("twenty verifier evidence faults cannot promote a candidate to PASS", () => {
  const changes: Array<(value: any) => void> = [
    value => { value.state.controller_sha = "0".repeat(40); },
    value => { value.state.base_sha = "0".repeat(40); },
    value => { value.state.candidate_sha = null; },
    value => { value.state.profile_hash = null; },
    value => { value.state.verifier_hash = null; },
    value => { value.state.material_hash = null; },
    value => { value.state.contract_hash = null; },
    value => { value.task.image = "mutable:latest"; },
    value => { value.state.checks[0].image = "sha256:" + "2".repeat(64); },
    value => { value.state.checks[0].argv = ["echo", "PASS"]; },
    value => { value.state.checks = []; },
    value => { value.state.checks.push(structuredClone(value.state.checks[0])); },
    value => { value.raw.clear(); },
    value => { value.raw.values().next().value.exit_code = 1; },
    value => { value.raw.values().next().value.timed_out = true; },
    value => { value.raw.values().next().value.stdout += "# skipped 1\n"; },
    value => { value.raw.values().next().value.stdout += "# cancelled 1\n"; },
    value => { value.state.checks[0].tap.complete = false; },
    value => { value.currentFingerprint = "0".repeat(64); },
    value => { value.treeMatches = false; },
  ];
  assert.equal(candidateVerdict(fixture()).status, "PASS");
  for (const [index, change] of changes.entries()) {
    const value = fixture(); change(value);
    assert.notEqual(candidateVerdict(value).status, "PASS", `fault ${index + 1} manufactured acceptance`);
  }
});

test("verification state stays distinct from execution completion", () => {
  const value = fixture();
  value.record.verification = undefined; assert.equal(candidateVerdict(value).status, "NOT_RUN");
  value.record.verification = { source_fingerprint: value.currentFingerprint };
  value.running = true; assert.equal(candidateVerdict(value).status, "VERIFYING");
  value.running = false; value.state.status = "completed"; assert.equal(candidateVerdict(value).status, "UNKNOWN");
  value.state.status = "failed"; value.state.checks[0].status = "FAIL"; value.raw.values().next().value.exit_code = 1;
  assert.equal(candidateVerdict(value).status, "FAIL");
  value.currentFingerprint = "0".repeat(64); assert.equal(candidateVerdict(value).status, "STALE");
});
