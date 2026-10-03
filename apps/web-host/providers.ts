import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectory, writePrivateFileAtomically } from "./storage.js";

export type ProviderProtocol = "openai-completions" | "openai-responses" | "anthropic-messages"
  | "chatgpt-subscription";
export type ProviderAuthType = "api-key" | "chatgpt-subscription";
export type ProviderAuthStatus = "configured" | "missing" | "invalid" | "expired" | "insecure";

export interface ProviderModelSettings {
  id: string;
  name: string;
  contextWindow?: number;
  thinkingLevels?: Array<"off" | "low" | "medium" | "high" | "max">;
  defaultThinkingLevel?: "off" | "low" | "medium" | "high" | "max";
}

export interface ProviderSettings {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  models: ProviderModelSettings[];
  builtin?: boolean;
}

export interface PublicProviderSettings extends Omit<ProviderSettings, "apiKey"> {
  apiKeyConfigured: boolean;
  authType: ProviderAuthType;
  authStatus: ProviderAuthStatus;
  authSource?: "settings" | "environment" | "codex-auth-cache";
  authFile?: string;
}

interface ProviderState {
  version: 1;
  providers: ProviderSettings[];
}

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
}

export const providerPresets: ProviderPreset[] = [
  { id: "anthropic", name: "Anthropic", protocol: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  { id: "cerebras", name: "Cerebras", protocol: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" },
  { id: "deepseek", name: "DeepSeek", protocol: "openai-completions", baseUrl: "https://api.deepseek.com" },
  { id: "fireworks", name: "Fireworks", protocol: "openai-completions", baseUrl: "https://api.fireworks.ai/inference/v1" },
  { id: "google", name: "Google Gemini", protocol: "openai-completions", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "groq", name: "Groq", protocol: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "huggingface", name: "Hugging Face", protocol: "openai-completions", baseUrl: "https://router.huggingface.co/v1" },
  { id: "mistral", name: "Mistral", protocol: "openai-completions", baseUrl: "https://api.mistral.ai/v1" },
  { id: "moonshotai", name: "Moonshot AI", protocol: "openai-completions", baseUrl: "https://api.moonshot.ai/v1" },
  { id: "nvidia", name: "NVIDIA", protocol: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { id: "openai", name: "OpenAI API", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", name: "OpenRouter", protocol: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "together", name: "Together AI", protocol: "openai-completions", baseUrl: "https://api.together.xyz/v1" },
  { id: "xai", name: "xAI", protocol: "openai-completions", baseUrl: "https://api.x.ai/v1" },
  { id: "zai", name: "Z.AI", protocol: "openai-completions", baseUrl: "https://api.z.ai/api/paas/v4" },
];

const defaultProviders: ProviderSettings[] = [
  {
    id: "openai",
    name: "OpenAI API",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    builtin: true,
    models: [{ id: "gpt-5.6-sol", name: "gpt-5.6-sol", contextWindow: 128_000,
      thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium" }],
  },
  {
    id: "chatgpt",
    name: "ChatGPT 订阅",
    protocol: "chatgpt-subscription",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    builtin: true,
    models: [{ id: "gpt-5.6-sol", name: "gpt-5.6-sol", contextWindow: 128_000,
      thinkingLevels: ["low", "medium", "high"], defaultThinkingLevel: "medium" }],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    builtin: true,
    models: [{ id: "deepseek-v4-flash", name: "deepseek-v4-flash", contextWindow: 1_000_000,
      thinkingLevels: ["off", "low", "high", "max"], defaultThinkingLevel: "off" }],
  },
];

const protocols = new Set<ProviderProtocol>([
  "openai-completions", "openai-responses", "anthropic-messages", "chatgpt-subscription",
]);

const builtinNames = new Map(defaultProviders.map((provider) => [provider.id, provider.name]));
const builtinOrder = new Map([["deepseek", 0], ["openai", 1], ["chatgpt", 2]]);

function validateIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9._-]{1,63}$/.test(normalized)) {
    throw new Error(`${label} 必须以小写字母开头，并且只能包含小写字母、数字、点、下划线或连字符`);
  }
  return normalized;
}

function validateBaseUrl(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); }
  catch { throw new Error("API 地址必须是有效 URL"); }
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "::1"
    || (isIP(parsed.hostname) === 4 && parsed.hostname.startsWith("127."));
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error("API 地址必须使用 HTTPS；本机回环地址可以使用 HTTP");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("API 地址不能包含凭据、查询参数或片段");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeModels(models: ProviderModelSettings[]): ProviderModelSettings[] {
  if (!Array.isArray(models) || models.length === 0) throw new Error("至少添加一个模型");
  const seen = new Set<string>();
  return models.map((model, index) => {
    const id = String(model?.id || "").trim();
    if (!id) throw new Error(`模型 ${index + 1} 缺少 ID`);
    if (seen.has(id)) throw new Error(`模型 ID 重复：${id}`);
    seen.add(id);
    const name = String(model?.name || id).trim() || id;
    const contextWindow = model.contextWindow === undefined ? undefined : Number(model.contextWindow);
    if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow <= 0)) {
      throw new Error(`模型 ${id} 的上下文容量无效`);
    }
    const allowedLevels = new Set(["off", "low", "medium", "high", "max"]);
    const thinkingLevels = (model.thinkingLevels?.map(String)
      .filter((level, levelIndex, entries) => allowedLevels.has(level)
        && entries.indexOf(level) === levelIndex)) as ProviderModelSettings["thinkingLevels"];
    const defaultThinkingLevel = model.defaultThinkingLevel;
    if (defaultThinkingLevel && !thinkingLevels?.includes(defaultThinkingLevel)) {
      throw new Error(`模型 ${id} 的默认推力强度不在可选范围内`);
    }
    return { id, name, ...(contextWindow ? { contextWindow } : {}),
      ...(thinkingLevels?.length ? { thinkingLevels } : {}),
      ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}) };
  });
}

function normalizeProvider(input: ProviderSettings, existing?: ProviderSettings): ProviderSettings {
  const id = validateIdentifier(String(input.id || ""), "Provider ID");
  const protocol = input.protocol;
  if (!protocols.has(protocol)) throw new Error("不支持的 API 协议");
  if (protocol === "chatgpt-subscription" && id !== "chatgpt") {
    throw new Error("ChatGPT 订阅登录只支持内置 chatgpt 提供方");
  }
  const name = builtinNames.get(id) || String(input.name || "").trim();
  if (!name) throw new Error("显示名称不能为空");
  const apiKey = protocol === "chatgpt-subscription" ? undefined
    : typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : existing?.apiKey;
  const baseUrl = validateBaseUrl(String(input.baseUrl || ""));
  if (protocol === "chatgpt-subscription" && baseUrl !== "https://chatgpt.com/backend-api/codex") {
    throw new Error("ChatGPT 订阅凭据只能发送到官方 Codex 接口");
  }
  const models = input.models.map((model) => {
    const previous = existing?.models.find((entry) => entry.id === model.id);
    return previous ? { ...previous, ...model } : model;
  });
  return {
    id,
    name,
    protocol,
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(protocol !== "chatgpt-subscription" && (input.apiKeyEnv || existing?.apiKeyEnv)
      ? { apiKeyEnv: input.apiKeyEnv || existing?.apiKeyEnv } : {}),
    models: normalizeModels(models),
    builtin: Boolean(existing?.builtin || input.builtin),
  };
}

interface LoginInspection {
  authStatus: ProviderAuthStatus;
  authSource?: "codex-auth-cache";
}

function accessTokenExpired(token: string): boolean {
  const payload = token.split(".")[1];
  if (!payload) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof claims.exp === "number" && claims.exp * 1000 <= Date.now();
  } catch {
    return false;
  }
}

async function inspectChatGptLogin(authFile: string): Promise<LoginInspection> {
  try {
    const info = await stat(authFile);
    if (!info.isFile()) return { authStatus: "missing" };
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      return { authStatus: "insecure" };
    }
    const auth = JSON.parse(await readFile(authFile, "utf8")) as {
      auth_mode?: unknown;
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    const accessToken = auth.tokens?.access_token;
    const accountId = auth.tokens?.account_id;
    if (auth.auth_mode !== "chatgpt" || typeof accessToken !== "string" || !accessToken.trim()
      || typeof accountId !== "string" || !accountId.trim()) {
      return { authStatus: "invalid" };
    }
    if (accessTokenExpired(accessToken)) return { authStatus: "expired" };
    return { authStatus: "configured", authSource: "codex-auth-cache" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { authStatus: "missing" };
    return { authStatus: "invalid" };
  }
}

async function publicProvider(provider: ProviderSettings, authFile: string): Promise<PublicProviderSettings> {
  const { apiKey, ...safe } = provider;
  if (provider.protocol === "chatgpt-subscription") {
    const inspection = await inspectChatGptLogin(authFile);
    return {
      ...safe,
      apiKeyConfigured: false,
      authType: "chatgpt-subscription",
      authFile,
      ...inspection,
    };
  }
  const environmentConfigured = Boolean(provider.apiKeyEnv && process.env[provider.apiKeyEnv]);
  return {
    ...safe,
    apiKeyConfigured: Boolean(apiKey || environmentConfigured),
    authType: "api-key",
    authStatus: apiKey || environmentConfigured ? "configured" : "missing",
    ...(apiKey ? { authSource: "settings" as const }
      : environmentConfigured ? { authSource: "environment" as const } : {}),
  };
}

export class ProviderRegistry {
  readonly stateDirectory: string;
  readonly statePath: string;
  readonly codexAuthFile: string;
  #providers = new Map<string, ProviderSettings>();
  #mutations = Promise.resolve();

  constructor(stateDirectory: string, options: { codexAuthFile?: string } = {}) {
    this.stateDirectory = stateDirectory;
    this.statePath = join(stateDirectory, "providers.json");
    const codexHome = String(process.env.CODEX_HOME || "").trim() || join(homedir(), ".codex");
    this.codexAuthFile = options.codexAuthFile || join(codexHome, "auth.json");
  }

  async load(): Promise<void> {
    await ensurePrivateDirectory(this.stateDirectory);
    for (const provider of defaultProviders) this.#providers.set(provider.id, provider);
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as ProviderState;
      for (const raw of parsed.providers || []) {
        const existing = this.#providers.get(String(raw.id || ""));
        const provider = normalizeProvider(existing?.builtin
          ? { ...raw, name: existing.name, builtin: true } : raw, existing);
        this.#providers.set(provider.id, provider);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.save();
  }

  async list(): Promise<PublicProviderSettings[]> {
    const providers = [...this.#providers.values()]
      .sort((a, b) => Number(Boolean(b.builtin)) - Number(Boolean(a.builtin))
        || (builtinOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (builtinOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        || a.name.localeCompare(b.name));
    return Promise.all(providers.map((provider) => publicProvider(provider, this.codexAuthFile)));
  }

  presets(): ProviderPreset[] {
    return providerPresets.filter((preset) => !this.#providers.has(preset.id));
  }

  async upsert(input: ProviderSettings): Promise<PublicProviderSettings> {
    const provider = await this.mutate(async () => {
      const existing = this.#providers.get(String(input.id || "").trim());
      const normalized = normalizeProvider(input, existing);
      this.#providers.set(normalized.id, normalized);
      try {
        await this.save();
        return normalized;
      } catch (error) {
        if (existing) this.#providers.set(existing.id, existing);
        else this.#providers.delete(normalized.id);
        throw error;
      }
    });
    return publicProvider(provider, this.codexAuthFile);
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const provider = this.#providers.get(id);
      if (!provider) return false;
      if (provider.builtin) throw new Error("内置提供方不能删除");
      this.#providers.delete(id);
      try {
        await this.save();
        return true;
      } catch (error) {
        this.#providers.set(id, provider);
        throw error;
      }
    });
  }

  async discover(input: { providerId?: string; baseUrl?: string; apiKey?: string }): Promise<ProviderModelSettings[]> {
    const stored = input.providerId ? this.#providers.get(input.providerId) : undefined;
    if (stored?.protocol === "chatgpt-subscription") {
      throw new Error("ChatGPT 订阅模型由本地登录提供，无需调用 API 获取");
    }
    const baseUrl = validateBaseUrl(String(input.baseUrl || stored?.baseUrl || ""));
    const key = String(input.apiKey || stored?.apiKey
      || (stored?.apiKeyEnv ? process.env[stored.apiKeyEnv] : "") || "").trim();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref();
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`获取模型失败（HTTP ${response.status}）`);
      const value = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }> };
      return (value.data || []).flatMap((entry) => {
        const id = typeof entry.id === "string" ? entry.id.trim() : "";
        return id ? [{ id, name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id }] : [];
      }).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw new Error("获取模型超时");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async save(): Promise<void> {
    const state: ProviderState = { version: 1, providers: [...this.#providers.values()] };
    await writePrivateFileAtomically(this.statePath,
      `${JSON.stringify(state, null, 2)}\n`);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.catch(() => undefined).then(operation);
    this.#mutations = result.then(() => undefined, () => undefined);
    return result;
  }
}
