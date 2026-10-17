import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspacePanel, sandboxedHtml } from "./WorkspacePanel.js";
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
