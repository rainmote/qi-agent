import { createHash } from "node:crypto";
import type { SourceFileFingerprint } from "../shared/workspace-verification.mjs";

export type CandidateVerificationStatus = "NOT_RUN" | "VERIFYING" | "PASS" | "FAIL" | "STALE" | "UNKNOWN";
export interface CandidateVerification {
  status: CandidateVerificationStatus; candidate_id: string; source_fingerprint?: string;
  base_sha: string; candidate_sha?: string; turn_id?: string; reason?: string;
  bindings?: { controller_sha: string; profile_sha256: string; verifier_sha256: string; material_sha256: string; contract_sha256: string; image: string };
  checks: Array<{ id: string; phase: string; status: string; argv?: string[]; exit_code?: number | null;
    started_at?: string; ended_at?: string; output_sha256?: string; details_url?: string }>;
}
export const sourceFingerprint = (files: SourceFileFingerprint[]) => createHash("sha256").update(JSON.stringify(files)).digest("hex");

/** Facts must come from loadTask/readArtifact in the pinned external controller.
 * No verdict field from a model, turn result or candidate file is consumed. */
export function candidateVerdict({ record, state, task, raw, currentFingerprint, treeMatches, running }: any): CandidateVerification {
  const intent = record.verification;
  const result: CandidateVerification = { status: "NOT_RUN", candidate_id: record.candidate_id,
    base_sha: record.base_sha, source_fingerprint: intent?.source_fingerprint, turn_id: intent?.turn_id, checks: [] };
  if (!intent) return result;
  if (state.base_sha !== record.base_sha || state.controller_sha !== record.controller_sha) return { ...result, status: "UNKNOWN", reason: "controller-binding-mismatch" };
  result.bindings = { controller_sha: state.controller_sha, profile_sha256: state.profile_hash,
    verifier_sha256: state.verifier_hash, material_sha256: state.material_hash,
    contract_sha256: state.contract_hash, image: task.image };
  const required: string[] = [...task.checks.map((check: any) => check.id), ...(task.acceptance ? ["acceptance"] : [])];
  const candidates = (state.checks || []).filter((check: any) => check.phase === "candidate");
  result.checks = required.map(id => {
    const matches = candidates.filter((check: any) => check.id === id);
    const check = matches.length === 1 ? matches[0] : null, output = check ? raw.get(check.output?.sha256) : null;
    const expectedArgv = id === "acceptance" ? ["node", "--test", "--test-reporter=tap", "/acceptance/" + task.acceptance.file] : task.checks.find((item: any) => item.id === id)?.argv;
    const complete = output && output.exit_code === 0 && !output.error && !output.signal && !output.timed_out && !output.output_limited
      && check.image === task.image && JSON.stringify(check.argv) === JSON.stringify(expectedArgv)
      && (id !== "acceptance" || (check.tap?.complete === true && check.tap.passed === true))
      && !/^(?:# |ℹ )(?:skipped|cancelled) [1-9]\d*$/mu.test(output.stdout || "");
    return { id, phase: "candidate", status: !check ? "NOT_RUN" : check.status === "PASS" ? complete ? "PASS" : "UNKNOWN" :
      check.timed_out || output?.timed_out || ["CANCELLED", "NOT_RUN"].includes(check.status) ? "UNKNOWN" : check.status,
      argv: check?.argv, exit_code: output?.exit_code ?? null, started_at: check?.started_at, ended_at: check?.ended_at,
      output_sha256: check?.output?.sha256,
      details_url: `/api/candidates/${record.candidate_id}/checks/${encodeURIComponent(id)}` };
  });
  if (currentFingerprint !== intent.source_fingerprint) return { ...result, status: "STALE", reason: "source-changed" };
  if (running) return { ...result, status: "VERIFYING" };
  const bindingsValid = [state.profile_hash, state.verifier_hash, state.material_hash, state.contract_hash]
    .every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    && /^(?:[\w./:-]+@)?sha256:[a-f0-9]{64}$/.test(task.image || "");
  const passed = state.status === "review_ready" && bindingsValid && treeMatches && /^[a-f0-9]{40}$/.test(state.candidate_sha || "")
    && required.length > 0 && new Set(required).size === required.length && candidates.length === required.length
    && result.checks.every(check => check.status === "PASS");
  if (passed) return { ...result, status: "PASS", candidate_sha: state.candidate_sha };
  if (state.status === "failed" && result.checks.some(check => check.status === "FAIL")
    && result.checks.every(check => ["PASS", "FAIL"].includes(check.status))) return { ...result, status: "FAIL", reason: state.reason };
  return { ...result, status: "UNKNOWN", reason: state.reason || "verification-unconfirmed" };
}
