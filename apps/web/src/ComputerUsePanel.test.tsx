import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComputerUsePanel } from "./ComputerUsePanel";
import type { ComputerUseStatus } from "./types";

const base: ComputerUseStatus = {
  enabled: true, provider: "lcu", "configured-provider": "lcu", connected: false,
  state: "disconnected", trusted: true, "local-desktop": true, "image-model": true,
  "input-scope": "host-desktop", tools: [], uncertain: null,
  capabilities: { surfaces: ["computer"], "system-permissions": "unverified", "browser-origin-consent": "unsupported" },
};
const render = (status?: ComputerUseStatus) => renderToStaticMarkup(<ComputerUsePanel status={status} onCommand={async () => {}} />);

test("computer status distinguishes unloaded, disabled, and connected without claiming OS permission", () => {
  assert.match(render(), /当前会话未加载电脑操作插件/);
  const disabled = render({ ...base, enabled: false, state: "disabled" });
  assert.match(disabled, /新的会话运行配置/); assert.doesNotMatch(disabled, /<button/);
  const connected = render({ ...base, connected: true, state: "connected", tools: ["computer_js", "computer_js_reset"] });
  assert.match(connected, /2 个模型工具/); assert.match(connected, /断开电脑操作/);
  assert.match(connected, /独立的应用审批/); assert.doesNotMatch(connected, /权限已授予/);
  const other = render({ ...base, provider: "cua-driver", "configured-provider": "cua-driver" });
  assert.match(other, /cua-driver/); assert.doesNotMatch(other, /LCU/);
});

test("trust, execution world, image model, and uncertainty prevent a new connection", () => {
  for (const status of [
    { ...base, trusted: false, state: "untrusted" as const },
    { ...base, "local-desktop": false, state: "unsupported-world" as const },
    { ...base, "image-model": false },
    { ...base, uncertain: { uncertain: true }, state: "uncertain" as const },
  ]) assert.match(render(status), /<button type="button" disabled/);
  assert.match(render({ ...base, uncertain: true, state: "uncertain" }), /核对上次操作/);
  assert.match(render(base), /<button type="button">连接电脑操作/);
});

test("Chrome opt-in is not advertised as completed origin consent and errors remain text", () => {
  const html = render({ ...base, capabilities: { ...base.capabilities, surfaces: ["browser", "computer"] }, error: "<script>untrusted</script>" });
  assert.match(html, /新站点请求会取消/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
});
