import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMessageAttachments, pluginResultData } from "./Timeline";
import type { DurableEvent } from "./types";
const attachment = { type: "attachment", id: "12345678-1234-1234-1234-123456789abc", workspaceId: "aabbccddeeff0011", name: "图表.png", mime: "image/png", size: 2048 };

test("typed user attachments show controlled previews and downloads", () => {
  const html = renderToStaticMarkup(<UserMessageAttachments content={[{ type: "text", text: "Read this" }, attachment,
    { ...attachment, id: "another-document", name: "说明.pdf", mime: "application/pdf" }]} />);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /alt="图表.png"/);
  assert.match(html, /\/api\/workspaces\/aabbccddeeff0011\/attachments\/12345678-1234-1234-1234-123456789abc\?download=0/);
  assert.match(html, /download="说明.pdf"/);
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("attachment names are escaped and malformed references never become URLs", () => {
  const html = renderToStaticMarkup(<UserMessageAttachments content={[
    { ...attachment, name: "<script>.png" }, { ...attachment, workspaceId: "../../secret" },
    { ...attachment, id: "javascript:alert(1)" }, { ...attachment, mime: "image/svg+xml" },
  ]} />);
  assert.match(html, /&lt;script&gt;.png/);
  assert.doesNotMatch(html, /<script|javascript:|\.\.\/|image\/svg/);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.equal((html.match(/附件引用不可用/g) || []).length, 2);
});

test("tool result slots restore their canonical data from persisted JSON", () => {
  const event = { data: { content: '{"label":"Count","value":3}' } } as unknown as DurableEvent;
  assert.deepEqual(pluginResultData(event), { label: "Count", value: 3 });
  assert.equal(pluginResultData({ data: { content: "not json" } } as unknown as DurableEvent), null);
  assert.equal(pluginResultData({ data: { content: " ".repeat(524289) } } as unknown as DurableEvent), null);
});
