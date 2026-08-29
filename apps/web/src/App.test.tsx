import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { PresetCards, PresetSelector, WorkspaceSelector, commandOutputNotice, creatorDraftPresetId, defaultPresetId, matchingCommands,
  selectablePresets } from "./App";
import { ContextMeter, ModelControl, PermissionControl, formatTokenCount, permissionIcon } from "./ComposerControls";
import { FullAccessDialog } from "./Dialogs";

const commands = [
  { name: "commands", description: "List commands" },
  { name: "compact", description: "Compact history" },
  { name: "model", description: "Select model" },
];

test("new-session preset selector exposes standard and creator modes", () => {
  const presets = selectablePresets([
    { id: "broken", name: "Broken", order: 0, trust: "user", broken: true },
    { id: "creator", name: "创造模式", order: 2, trust: "system" },
    { id: "standard", name: "标准模式", order: 1, trust: "system" },
  ]);
  assert.equal(defaultPresetId(presets), "standard");
  assert.equal(creatorDraftPresetId(presets), "creator");
  assert.deepEqual(presets.map((preset) => preset.id), ["standard", "creator"]);
  const html = renderToStaticMarkup(
    <PresetSelector presets={presets} value="creator" onChange={() => undefined} />,
  );
  assert.match(html, /aria-label="Agent 模式"/);
  assert.match(html, /value="standard"/);
  assert.match(html, /value="creator" selected=""/);
  assert.match(html, /标准模式/);
  assert.match(html, /创造模式/);
});

test("new-session preset cards explain modes and expose radio state", () => {
  const html = renderToStaticMarkup(<PresetCards presets={[
    { id: "standard", name: "标准模式", trust: "system" },
    { id: "creator", name: "创造模式", trust: "system" },
  ]} value="creator" onChange={() => undefined} />);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /适合编码、分析与日常项目协作/);
  assert.match(html, /创建、检查并迭代 Agent preset/);
  assert.match(html, /aria-checked="true"/);
});

test("creator draft entry is hidden when the creator preset is unavailable", () => {
  assert.equal(creatorDraftPresetId([
    { id: "standard", name: "标准模式", trust: "system" },
    { id: "creator", name: "创造模式", trust: "system", broken: true },
  ]), null);
});

test("workspace selector keeps adding a workspace beside selection", () => {
  const html = renderToStaticMarkup(<WorkspaceSelector workspaces={[
    { id: "workspace-1", name: "DAO", path: "/workspace/dao", addedAt: "2026-08-29" },
  ]} value="workspace-1" onChange={() => undefined} onAdd={() => undefined} />);
  assert.match(html, /aria-label="选择工作区"/);
  assert.match(html, /value="workspace-1" selected=""/);
  assert.match(html, /aria-label="添加新的工作区"/);
  assert.match(html, /添加工作区/);
});

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

test("composer permission control uses a distinct icon for every access mode", () => {
  assert.deepEqual([permissionIcon("deny"), permissionIcon("ask"), permissionIcon("allow")],
    ["eye", "folderEdit", "shieldAlert"]);
  const html = renderToStaticMarkup(<PermissionControl policy={{
    mode: "deny",
    modes: [
      { id: "deny", label: "Read Only" },
      { id: "ask", label: "Workspace Write" },
      { id: "allow", label: "Full Access" },
    ],
  }} onChange={() => undefined} />);
  assert.match(html, /访问权限：Read Only/);
  assert.match(html, />Read Only</);
});

test("model control shows reasoning effort without a leading model icon", () => {
  const html = renderToStaticMarkup(<ModelControl models={[{
    id: "deepseek", model: "deepseek-v4-flash",
    "thinking-levels": ["off", "low", "high", "max"], "thinking-level": "high",
  }]} selectedId="deepseek" thinkingLevel="high"
    onSelectModel={() => undefined} onSelectThinking={() => undefined} />);
  assert.match(html, /模型：deepseek-v4-flash，推力 High/);
  assert.match(html, /model-trigger-effort">High/);
  assert.doesNotMatch(html, /<rect x="4" y="7" width="16" height="13"/);
});

test("context meter exposes usage and compact token formatting", () => {
  assert.equal(formatTokenCount(22_300), "22.3K");
  assert.equal(formatTokenCount(1_000_000), "1M");
  const html = renderToStaticMarkup(<ContextMeter status={{
    used_tokens: 22_300, context_window: 1_000_000, percent: 2,
    system_tokens: 8_000, tool_tokens: 10_000, message_tokens: 4_300,
  }} />);
  assert.match(html, /上下文已用 2%/);
  assert.match(html, /stroke-dasharray="2 100"/);
});

test("full access confirmation requires explicit risk acknowledgement", () => {
  const html = renderToStaticMarkup(<FullAccessDialog onClose={() => undefined} onConfirm={() => undefined} />);
  assert.match(html, /确认启用 Full Access/);
  assert.match(html, /我已了解风险，并愿意继续/);
  assert.match(html, /disabled=""[^>]*>启用 Full Access/);
});
