import { renderToStaticMarkup } from "react-dom/server";
import assert from "node:assert/strict";
import test from "node:test";
import { providerAuthSummary, ProviderReloadNotice } from "./ProviderSettingsPanel";
import type { ProviderSettings } from "./types";

const baseProvider: ProviderSettings = {
  id: "openai",
  name: "OpenAI API",
  protocol: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  apiKeyConfigured: false,
  authType: "api-key",
  authStatus: "missing",
  models: [{ id: "gpt-5.6-sol", name: "gpt-5.6-sol" }],
};

test("provider auth copy distinguishes API keys from ChatGPT subscription login", () => {
  assert.equal(providerAuthSummary(baseProvider), "API 方式 · API Key 未配置");
  assert.equal(providerAuthSummary({ ...baseProvider, apiKeyConfigured: true,
    authStatus: "configured", authSource: "environment" }), "API 方式 · 已从环境变量读取");
  assert.equal(providerAuthSummary({ ...baseProvider,
    id: "chatgpt",
    name: "ChatGPT 订阅",
    protocol: "chatgpt-subscription",
    authType: "chatgpt-subscription",
    authStatus: "configured",
  }), "订阅方式 · 已发现本地登录");
  assert.equal(providerAuthSummary({ ...baseProvider,
    id: "chatgpt",
    name: "ChatGPT 订阅",
    protocol: "chatgpt-subscription",
    authType: "chatgpt-subscription",
    authStatus: "expired",
  }), "订阅方式 · 登录已过期");
});


test("provider reload notice distinguishes saved configuration from effective sessions", () => {
  const html = renderToStaticMarkup(<ProviderReloadNotice report={{ scope: "open-web-sessions", applied: ["ok"],
    failures: [{ sessionId: "failed", sessionName: "测试会话", message: "超时" }] }} retrying={false} onRetry={() => {}} />);
  assert.match(html, /配置已保存，1 个 Web 会话尚未生效/);
  assert.match(html, /测试会话/); assert.match(html, /重试未生效会话/);
});
