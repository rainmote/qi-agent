import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AutomationPanel, scheduleParameters } from "./AutomationPanel";

test("automation forms preserve explicit timezone and convert minutes to daemon milliseconds", () => {
  assert.deepEqual(scheduleParameters("  check  ", "daily", "09:00", "Asia/Hong_Kong"),
    { prompt: "check", daily: "09:00", timezone: "Asia/Hong_Kong" });
  assert.deepEqual(scheduleParameters("check", "delay_ms", "1.5", "UTC"),
    { prompt: "check", delay_ms: 90000, timezone: "UTC" });
  assert.throws(() => scheduleParameters("check", "delay_ms", "-1", "UTC"));
  assert.throws(() => scheduleParameters("check", "daily", "09:00", "Mars/Unknown"));
  assert.throws(() => scheduleParameters(" ", "daily", "09:00", "UTC"));
});

test("read-only automation panel exposes controls but disables every mutation", () => {
  const markup = renderToStaticMarkup(<AutomationPanel rpc={async () => []} agentId="observer" readOnly />);
  assert.match(markup, /当前为只读会话/);
  assert.match(markup, /disabled="">创建计划任务/);
  assert.match(markup, /disabled="">创建并开始/);
  assert.match(markup, /暂停或完成只停止后续续跑/);
});
