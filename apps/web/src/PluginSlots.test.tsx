import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginSlots, validPluginData, type PluginSlot } from "./PluginSlots";
import { PluginPanel } from "./PluginPanel";
const slot = (patch: Partial<PluginSlot> = {}): PluginSlot => ({
  id: "example", "package-id": "sample", version: "1.0.0", slot: "panel",
  type: "text", title: "Example", data: { text: "Ready" }, ...patch,
});

test("plugin markdown never executes HTML or silently loads remote images", () => {
  const html = renderToStaticMarkup(<PluginSlots slots={[slot({ type: "markdown", data: {
    text: '<script>alert(1)</script>\n\n![tracker](https://invalid.example/image.png)\n\n[unsafe](javascript:alert(1))\n\n[docs](https://example.com/)',
  } })]} />);
  assert.doesNotMatch(html, /<script|<img|href="javascript:|src="https:/);
  assert.match(html, /href="https:\/\/example.com\/"/);
  assert.match(html, /rel="noreferrer noopener"/);
});

test("tool result slots are scoped to their named tool and validate runtime data", () => {
  const slots = [slot({ slot: "tool-result", tool: "sample_value", type: "metric", data: { label: "Count", value: 1 } })];
  assert.equal(renderToStaticMarkup(<PluginSlots slots={slots} slot="tool-result" toolName="another" />), "");
  const html = renderToStaticMarkup(<PluginSlots slots={slots} slot="tool-result" toolName="sample_value" data={{ label: "Count", value: 2 }} />);
  assert.match(html, /Count/); assert.match(html, /2/);
  const invalid = renderToStaticMarkup(<PluginSlots slots={slots} slot="tool-result" toolName="sample_value" data={{ html: "<svg>" }} />);
  assert.match(invalid, /扩展数据格式不匹配/);
  assert.doesNotMatch(invalid, /<svg/);
});

test("declarative renderers reject unsupported or unbounded data", () => {
  assert.equal(validPluginData("table", { columns: ["Count"], rows: [[1]] }), true);
  assert.equal(validPluginData("table", { columns: ["Count"], rows: Array.from({ length: 201 }, () => [1]) }), false);
  assert.equal(validPluginData("text", { text: "a".repeat(16001) }), false);
  assert.equal(validPluginData("html" as "text", { text: "unsafe" }), false);
  const html = renderToStaticMarkup(<PluginSlots slots={[slot({ data: { text: "<script>alert(1)</script>" } })]} />);
  assert.match(html, /&lt;script&gt;/);
});

test("read-only package management disables all install controls", () => {
  const html = renderToStaticMarkup(<PluginPanel readOnly rpc={async () => ({})} />);
  assert.match(html, /观察模式/);
  assert.match(html, /<button[^>]*disabled=""/);
  assert.match(html, /aria-label="插件包位置"[^>]*disabled=""/);
});
