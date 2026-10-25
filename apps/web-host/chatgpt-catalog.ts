import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { ProviderAuthStatus, ProviderModelSettings } from "./providers.js";

export const chatGptBaseUrl = "https://chatgpt.com/backend-api/codex";
// Codex model-catalog protocol version; this is not a pinned model list.
const catalogUrl = `${chatGptBaseUrl}/models?client_version=0.163.0`;
class CatalogError extends Error {}

const efforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export async function readChatGptLogin(path: string): Promise<{
  authStatus: ProviderAuthStatus; accessToken?: string; accountId?: string; identity?: string;
}> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > 262144) return { authStatus: "invalid" };
    if (process.platform !== "win32" && ((info.mode & 0o077) !== 0
      || (process.getuid && info.uid !== process.getuid()))) return { authStatus: "insecure" };
    const auth = JSON.parse(await file.readFile("utf8"));
    const accessToken = auth?.tokens?.access_token, accountId = auth?.tokens?.account_id;
    if (auth?.auth_mode !== "chatgpt" || typeof accessToken !== "string" || !accessToken.trim()
      || typeof accountId !== "string" || !accountId.trim()) return { authStatus: "invalid" };
    let claims: { exp?: number; sub?: string } = {};
    try {
      const parsed = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
      if (parsed && typeof parsed === "object") claims = parsed;
    } catch { /* opaque token */ }
    if (typeof claims.exp === "number" && claims.exp * 1000 <= Date.now()) return { authStatus: "expired" };
    return { authStatus: "configured", accessToken, accountId,
      identity: createHash("sha256").update(JSON.stringify([accountId, typeof claims.sub === "string" ? claims.sub : ""])).digest("hex") };
  } catch (error) {
    return { authStatus: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" };
  } finally { await file?.close(); }
}

export function parseChatGptModels(value: unknown): ProviderModelSettings[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { models?: unknown }).models)) {
    throw new CatalogError("ChatGPT 模型目录格式无效");
  }
  const seen = new Set<string>();
  const models = (value as { models: Array<Record<string, unknown>> }).models
    .filter(model => model && model.visibility === "list")
    .sort((a, b) => (typeof a.priority === "number" ? a.priority : Infinity)
      - (typeof b.priority === "number" ? b.priority : Infinity))
    .map(model => {
      if (typeof model.slug !== "string" || !model.slug.trim() || seen.has(model.slug)) {
        throw new CatalogError("ChatGPT 模型目录包含无效或重复的模型 ID");
      }
      seen.add(model.slug);
      const levels = Array.isArray(model.supported_reasoning_levels)
        ? [...new Set(model.supported_reasoning_levels.flatMap(level =>
          level && typeof level === "object" && efforts.has(level.effort) ? [level.effort] : []))] as NonNullable<ProviderModelSettings["thinkingLevels"]> : [];
      // Ultra is Codex's team mode, not an inference reasoning.effort value.
      const defaultLevel = levels.find(level => level === model.default_reasoning_level) || levels[0];
      return { id: model.slug, name: typeof model.display_name === "string" && model.display_name.trim()
        ? model.display_name : model.slug,
      ...(Number.isSafeInteger(model.context_window) && Number(model.context_window) > 0
        ? { contextWindow: Number(model.context_window) } : {}),
      ...(levels.length ? { thinkingLevels: levels, defaultThinkingLevel: defaultLevel } : {}) };
    });
  if (!models.length) throw new CatalogError("ChatGPT 模型目录没有可用模型，请稍后刷新");
  return models;
}

export async function fetchChatGptModels(authFile: string) {
  const login = await readChatGptLogin(authFile);
  if (login.authStatus !== "configured") throw new CatalogError("ChatGPT 登录不可用，请重新登录后刷新模型列表");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  timer.unref();
  try {
    const response = await fetch(catalogUrl, { headers: {
      authorization: `Bearer ${login.accessToken}`, "chatgpt-account-id": login.accountId!,
      originator: "codex_cli_rs", "user-agent": "qi-agent/0.1", accept: "application/json",
    }, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new CatalogError(`获取 ChatGPT 模型失败（HTTP ${response.status}）`);
    if (!response.body) throw new CatalogError("ChatGPT 模型目录响应为空");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 2 * 1024 * 1024) {
          controller.abort();
          throw new CatalogError("ChatGPT 模型目录响应超过大小限制");
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const models = parseChatGptModels(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const current = await readChatGptLogin(authFile);
    if (current.identity !== login.identity || current.accessToken !== login.accessToken) {
      throw new CatalogError("ChatGPT 登录已变化，请重新刷新模型列表");
    }
    return { models, identity: login.identity! };
  } catch (error) {
    // Never forward transport errors or response bodies containing credentials.
    if (error instanceof CatalogError) throw error;
    if (controller.signal.aborted) throw new CatalogError("获取 ChatGPT 模型超时，请稍后刷新");
    throw new CatalogError("无法获取 ChatGPT 模型，请检查连接后刷新");
  } finally { clearTimeout(timer); }
}
