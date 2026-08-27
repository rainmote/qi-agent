import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

export type ProviderProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface ProviderModelSettings {
  id: string;
  name: string;
  contextWindow?: number;
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
  { id: "openai", name: "OpenAI", protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", name: "OpenRouter", protocol: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "together", name: "Together AI", protocol: "openai-completions", baseUrl: "https://api.together.xyz/v1" },
  { id: "xai", name: "xAI", protocol: "openai-completions", baseUrl: "https://api.x.ai/v1" },
  { id: "zai", name: "Z.AI", protocol: "openai-completions", baseUrl: "https://api.z.ai/api/paas/v4" },
];

const defaultProviders: ProviderSettings[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    builtin: true,
    models: [{ id: "gpt-5.6-sol", name: "gpt-5.6-sol", contextWindow: 128_000 }],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    builtin: true,
    models: [{ id: "deepseek-v4-flash", name: "deepseek-v4-flash", contextWindow: 1_000_000 }],
  },
];

const protocols = new Set<ProviderProtocol>([
  "openai-completions", "openai-responses", "anthropic-messages",
]);

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
    return { id, name, ...(contextWindow ? { contextWindow } : {}) };
  });
}

function normalizeProvider(input: ProviderSettings, existing?: ProviderSettings): ProviderSettings {
  const id = validateIdentifier(String(input.id || ""), "Provider ID");
  const protocol = input.protocol;
  if (!protocols.has(protocol)) throw new Error("不支持的 API 协议");
  const name = String(input.name || "").trim();
  if (!name) throw new Error("显示名称不能为空");
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim()
    ? input.apiKey.trim() : existing?.apiKey;
  return {
    id,
    name,
    protocol,
    baseUrl: validateBaseUrl(String(input.baseUrl || "")),
    ...(apiKey ? { apiKey } : {}),
    ...(input.apiKeyEnv || existing?.apiKeyEnv ? { apiKeyEnv: input.apiKeyEnv || existing?.apiKeyEnv } : {}),
    models: normalizeModels(input.models),
    builtin: Boolean(existing?.builtin || input.builtin),
  };
}

function publicProvider(provider: ProviderSettings): PublicProviderSettings {
  const { apiKey, ...safe } = provider;
  return {
    ...safe,
    apiKeyConfigured: Boolean(apiKey || (provider.apiKeyEnv && process.env[provider.apiKeyEnv])),
  };
}

export class ProviderRegistry {
  readonly stateDirectory: string;
  readonly statePath: string;
  #providers = new Map<string, ProviderSettings>();

  constructor(stateDirectory: string) {
    this.stateDirectory = stateDirectory;
    this.statePath = join(stateDirectory, "providers.json");
  }

  async load(): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    for (const provider of defaultProviders) this.#providers.set(provider.id, provider);
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as ProviderState;
      for (const raw of parsed.providers || []) {
        const existing = this.#providers.get(String(raw.id || ""));
        const provider = normalizeProvider(raw, existing);
        this.#providers.set(provider.id, provider);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.save();
  }

  list(): PublicProviderSettings[] {
    return [...this.#providers.values()]
      .sort((a, b) => Number(Boolean(b.builtin)) - Number(Boolean(a.builtin)) || a.name.localeCompare(b.name))
      .map(publicProvider);
  }

  presets(): ProviderPreset[] {
    return providerPresets.filter((preset) => !this.#providers.has(preset.id));
  }

  async upsert(input: ProviderSettings): Promise<PublicProviderSettings> {
    const existing = this.#providers.get(String(input.id || "").trim());
    const provider = normalizeProvider(input, existing);
    this.#providers.set(provider.id, provider);
    await this.save();
    return publicProvider(provider);
  }

  async remove(id: string): Promise<boolean> {
    const provider = this.#providers.get(id);
    if (!provider) return false;
    if (provider.builtin) throw new Error("内置提供方不能删除");
    const removed = this.#providers.delete(id);
    if (removed) await this.save();
    return removed;
  }

  async discover(input: { providerId?: string; baseUrl?: string; apiKey?: string }): Promise<ProviderModelSettings[]> {
    const stored = input.providerId ? this.#providers.get(input.providerId) : undefined;
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
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    const state: ProviderState = { version: 1, providers: [...this.#providers.values()] };
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}
