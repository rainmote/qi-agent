import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspacePanel, WorkspaceVerificationSummary, sandboxedHtml } from "./WorkspacePanel.js";
import { ComposerAttachments } from "./ComposerAttachments.js";

test("workspace panel exposes accessible navigation and attachment controls inherit disabled state", () => {
  const html = renderToStaticMarkup(<WorkspacePanel workspaceId="fixture" api={{ list: async () => ({ path: "", entries: [], truncated: false }), search: async () => ({ path: "", entries: [], truncated: false }), preview: async () => { throw new Error("unused"); }, contentUrl: () => "/fixture" }} />);
  assert.match(html, /aria-label="工作区文件"/); assert.match(html, /aria-label="搜索文件路径"/);
  const attachments = renderToStaticMarkup(<ComposerAttachments workspaceId="fixture" items={[{ type: "attachment", id: "item-fixture", name: "draft.txt", size: 10, mime: "text/plain", workspaceId: "fixture" }]} onChange={() => {}} upload={async () => { throw new Error("unused"); }} disabled />);
  assert.match(attachments, /aria-label="移除 draft.txt" disabled/); assert.match(attachments, /每个 ≤8 MiB/);
});

test("HTML preview starts with a restrictive policy even when uploaded HTML supplies its own policy", () => {
  const html = sandboxedHtml('<meta http-equiv="Content-Security-Policy" content="default-src *"><script>top.location="https://example.invalid"</script>');
  assert.match(html, /^<meta http-equiv="Content-Security-Policy" content="default-src 'none'/);
  assert.match(html, /form-action 'none'/);
});


test("verification summary distinguishes independent PASS from absent and unconfirmed evidence", () => {
  const base = { turnId: "fixture-turn", files: [], partial: false };
  const pending = renderToStaticMarkup(<WorkspaceVerificationSummary changes={base} />);
  assert.match(pending, /尚未关联本轮文件指纹的独立验收记录/);
  for (const status of ["UNKNOWN", "NOT_RUN"] as const) {
    const html = renderToStaticMarkup(<WorkspaceVerificationSummary changes={{ ...base, verification: { status } }} />);
    assert.doesNotMatch(html, /独立验收通过/);
  }
  const passed = renderToStaticMarkup(<WorkspaceVerificationSummary changes={{ ...base, verification: { status: "PASS", checks: [{ id: "acceptance", status: "PASS" }] } }} />);
  const partial = renderToStaticMarkup(<WorkspaceVerificationSummary changes={{ ...base, partial: true, verification: { status: "PASS", checks: [{ id: "acceptance", status: "PASS" }] } }} />);
  assert.doesNotMatch(partial, /独立验收通过/);
  assert.match(passed, /独立验收通过 · 1 项检查/); assert.match(passed, /合入与发布仍需明确授权/);
});
