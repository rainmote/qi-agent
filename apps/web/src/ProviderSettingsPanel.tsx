import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import type { ProviderInput, ProviderModelSettings, ProviderPreset, ProviderProtocol,
  ProviderSettings, ProviderReloadResult } from "./types";

type ProviderDraft = ProviderInput;
type Editor = {
  kind: "edit" | "preset" | "custom";
  draft: ProviderDraft;
  advanced: boolean;
  apiKeyConfigured?: boolean;
  provider?: ProviderSettings;
};

const protocolLabels: Partial<Record<ProviderProtocol, string>> = {
  "openai-completions": "openai-completions",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages",
};

function draftFromProvider(provider: ProviderSettings): ProviderDraft {
  const { apiKeyConfigured: _configured, authType: _authType, authStatus: _authStatus,
    authSource: _authSource, authFile: _authFile, ...draft } = provider;
  return { ...draft, models: provider.models.map((model) => ({ ...model })), apiKey: "" };
}

export function providerAuthSummary(provider: ProviderSettings): string {
  if (provider.authType === "chatgpt-subscription") {
    switch (provider.authStatus) {
      case "configured": return "订阅方式 · 已发现本地登录";
      case "expired": return "订阅方式 · 登录已过期";
      case "insecure": return "订阅方式 · 凭据权限不安全";
      case "invalid": return "订阅方式 · 登录状态无效";
      default: return "订阅方式 · 未发现本地登录";
    }
  }
  if (provider.authStatus !== "configured") return "API 方式 · API Key 未配置";
  return provider.authSource === "environment"
    ? "API 方式 · 已从环境变量读取" : "API 方式 · API Key 已配置";
}

function draftFromPreset(preset: ProviderPreset): ProviderDraft {
  return {
    id: preset.id,
    name: preset.name,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    models: [],
    apiKey: "",
  };
}

function customDraft(): ProviderDraft {
  return {
    id: "",
    name: "",
    protocol: "openai-completions",
    baseUrl: "",
    models: [],
    apiKey: "",
  };
}

function validDraft(draft: ProviderDraft): boolean {
  return /^[a-z][a-z0-9._-]{1,63}$/.test(draft.id)
    && Boolean(draft.name.trim() && draft.baseUrl.trim())
    && draft.models.length > 0
    && draft.models.every((model) => model.id.trim());
}

function ModelCatalog({ models, onChange, onDiscover, discovering }: {
  models: ProviderModelSettings[];
  onChange: (models: ProviderModelSettings[]) => void;
  onDiscover?: () => void;
  discovering: boolean;
}) {
  const update = (index: number, patch: Partial<ProviderModelSettings>) => {
    onChange(models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model));
  };
  return <section className="provider-model-catalog" aria-label="模型目录">
    <div className="provider-catalog-head"><div><strong>模型目录</strong>
      <span>{models.length ? `${models.length} 个可选模型` : "模型选择器中将不显示任何模型"}</span></div>
      {onDiscover && <button type="button" className="button ghost compact-button" disabled={discovering}
        onClick={onDiscover}><Icon name="refresh" />{discovering ? "正在获取" : "获取可用模型"}</button>}</div>
    <div className="provider-model-list">
      {models.map((model, index) => <div className="provider-model-row" key={index}>
        <input aria-label={`模型 ID ${index + 1}`} placeholder="模型 ID" value={model.id}
          onChange={(event) => update(index, { id: event.target.value,
            ...(model.name === model.id || !model.name ? { name: event.target.value } : {}) })} />
        <input aria-label={`显示名称 ${index + 1}`} placeholder="显示名称" value={model.name}
          onChange={(event) => update(index, { name: event.target.value })} />
        <input className="provider-capacity" type="number" min={1} aria-label={`上下文容量 ${index + 1}`}
          placeholder="容量" value={model.contextWindow || ""}
          onChange={(event) => update(index, { contextWindow: event.target.value ? Number(event.target.value) : undefined })} />
        <button type="button" className="icon-button compact" aria-label={`删除模型 ${index + 1}`}
          onClick={() => onChange(models.filter((_, modelIndex) => modelIndex !== index))}><Icon name="trash" /></button>
      </div>)}
    </div>
    <button type="button" className="provider-add-model" onClick={() => onChange([...models, { id: "", name: "" }])}>
      <Icon name="plus" />添加模型
    </button>
  </section>;
}

function ProviderEditor({ editor, presets, onEditor, onSaved }: {
  editor: Editor;
  presets: ProviderPreset[];
  onEditor: (editor: Editor | null) => void;
  onSaved: (reload?: ProviderReloadResult) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = editor.draft;
  const subscription = draft.protocol === "chatgpt-subscription";
  const patch = (value: Partial<ProviderDraft>) => onEditor({ ...editor, draft: { ...draft, ...value } });
  const discover = async () => {
    if (!draft.baseUrl.trim()) return;
    setDiscovering(true); setError(null);
    try {
      const models = await api.discoverProviderModels({
        providerId: editor.kind === "edit" ? draft.id : undefined,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey || undefined,
      });
      if (!models.length) throw new Error("提供方没有返回可用模型");
      patch({ models });
    } catch (value) { setError(value instanceof Error ? value.message : "无法获取模型"); }
    finally { setDiscovering(false); }
  };
  const save = async () => {
    if (!validDraft(draft)) return;
    setBusy(true); setError(null);
    try {
      const result = await api.saveProvider(draft);
      await onSaved(result.reload);
      onEditor(null);
    } catch (value) { setError(value instanceof Error ? value.message : "无法保存提供方"); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (draft.builtin || editor.kind !== "edit"
      || !window.confirm(`确定删除提供方“${draft.name}”吗？`)) return;
    setBusy(true); setError(null);
    try {
      const result = await api.removeProvider(draft.id);
      await onSaved(result.reload);
      onEditor(null);
    } catch (value) { setError(value instanceof Error ? value.message : "无法删除提供方"); }
    finally { setBusy(false); }
  };
  const refreshLogin = async () => {
    setBusy(true); setError(null);
    try {
      await onSaved();
      onEditor(null);
    } catch (value) { setError(value instanceof Error ? value.message : "无法刷新登录状态"); }
    finally { setBusy(false); }
  };
  return <div className="provider-editor">
    {editor.kind === "edit" && <div className="provider-editor-identity"><strong>{draft.name}</strong><span>{draft.id}</span></div>}
    {editor.kind !== "edit" && <div className="provider-editor-title">
      {editor.kind === "custom" ? "自定义提供方" : "提供方"}
    </div>}
    {editor.kind === "preset" && <label>提供方<select aria-label="提供方" value={draft.id}
      onChange={(event) => {
        const preset = presets.find((entry) => entry.id === event.target.value);
        if (preset) onEditor({ ...editor, draft: draftFromPreset(preset) });
      }}>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.id}</option>)}</select></label>}
    {editor.kind === "custom" && <><label>Provider ID<input aria-label="Provider ID" placeholder="acme-gateway"
      value={draft.id} onChange={(event) => patch({ id: event.target.value.toLocaleLowerCase() })} /></label>
      <p className="provider-field-help">以小写字母开头的标识，在请求中唯一标识该提供方。</p></>}
    {editor.kind === "custom" && <label>显示名称<input aria-label="显示名称" value={draft.name}
      onChange={(event) => patch({ name: event.target.value })} /></label>}
    {subscription && editor.provider && <section className="subscription-login" aria-label="ChatGPT 本地登录状态">
      <div className="subscription-login-head"><span className={`provider-status ${editor.provider.authStatus === "configured" ? "configured" : ""}`} />
        <strong>{providerAuthSummary(editor.provider)}</strong></div>
      <p>自动读取 Codex 的本地 ChatGPT 登录，不需要填写 OpenAI API Key，也不会向 Web 返回访问令牌。</p>
      {editor.provider.authFile && <code>{editor.provider.authFile}</code>}
      {editor.provider.authStatus !== "configured" && <p className="subscription-login-help">
        请在终端运行 <code>codex login</code>，完成后刷新登录状态。
      </p>}
    </section>}
    {editor.kind !== "custom" && !subscription && <label>API 密钥<input type="password" aria-label="API 密钥"
      placeholder={editor.apiKeyConfigured ? "已配置——输入新值可替换" : "输入 API 密钥，或留空使用环境认证"}
      value={draft.apiKey || ""} onChange={(event) => patch({ apiKey: event.target.value })} /></label>}
    {editor.kind !== "custom" && !subscription && <button type="button" className={`provider-advanced-toggle ${editor.advanced ? "open" : ""}`}
      onClick={() => onEditor({ ...editor, advanced: !editor.advanced })}>
      <Icon name="chevron" />自定义设置
    </button>}
    {!subscription && (editor.kind === "custom" || editor.advanced) && <div className="provider-advanced-fields">
      <label>API 地址<input aria-label="API 地址" placeholder="https://gateway.example/v1" value={draft.baseUrl}
        onChange={(event) => patch({ baseUrl: event.target.value })} /></label>
      <label className="provider-protocol-field">API 协议<select aria-label="API 协议" value={draft.protocol}
        onChange={(event) => patch({ protocol: event.target.value as ProviderProtocol })}>
        {Object.entries(protocolLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      {editor.kind === "custom" && <label>API 密钥<input type="password" aria-label="API 密钥"
        placeholder="输入 API 密钥" value={draft.apiKey || ""}
        onChange={(event) => patch({ apiKey: event.target.value })} /></label>}
      <ModelCatalog models={draft.models} onChange={(models) => patch({ models })}
        onDiscover={() => void discover()} discovering={discovering} />
    </div>}
    {editor.kind !== "custom" && !editor.advanced && !draft.models.length
      && <p className="provider-field-help">展开自定义设置，获取或添加至少一个模型。</p>}
    {error && <p className="form-error">{error}</p>}
    <div className="provider-editor-actions">
      {editor.kind === "edit" && !draft.builtin && <button type="button" className="button danger provider-delete"
        disabled={busy} onClick={() => void remove()}>删除提供方</button>}
      <button type="button" className="button ghost" disabled={busy} onClick={() => onEditor(null)}>取消</button>
      {subscription ? <button type="button" className="button primary" disabled={busy} onClick={() => void refreshLogin()}>
        <Icon name="refresh" />{busy ? "正在刷新" : "刷新登录状态"}
      </button> : <button type="button" className="button primary" disabled={busy || !validDraft(draft)} onClick={() => void save()}>
        {editor.kind === "custom" ? "创建提供方" : "保存"}
      </button>}
    </div>
  </div>;
}

export function ProviderReloadNotice({ report, retrying, onRetry }: {
  report: ProviderReloadResult; retrying: boolean; onRetry: () => void;
}) {
  return <div className="provider-reload-notice" role="status">
    <p>{report.failures.length ? `配置已保存，${report.failures.length} 个 Web 会话尚未生效。`
      : report.applied.length ? `配置已保存，已更新 ${report.applied.length} 个 Web 会话。`
        : "配置已保存，将在新打开的 Web 会话中加载。"}</p>
    {!!report.warnings?.length && <ul>{report.warnings.map((warning, index) =>
      <li key={`${warning.sessionId}-${index}`}><strong>{warning.sessionName}</strong>：{warning.message}</li>)}</ul>}
    {report.failures.length > 0 && <>
      <ul>{report.failures.map((failure) => <li key={failure.sessionId}>
        <strong>{failure.sessionName}</strong>：{failure.message}</li>)}</ul>
      <button type="button" className="button ghost" disabled={retrying} onClick={onRetry}>
        {retrying ? "正在重试…" : "重试未生效会话"}</button>
    </>}
  </div>;
}

export function ProviderSettingsPanel({ onChanged }: { onChanged?: () => Promise<void> | void }) {
  const [providers, setProviders] = useState<ProviderSettings[]>([]);
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true); setError(null);
    try {
      const result = await api.listProviders();
      setProviders(result.providers); setPresets(result.presets);
    } catch (value) { setError(value instanceof Error ? value.message : "无法读取提供方"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const [reload, setReload] = useState<ProviderReloadResult | null>(null);
  const [retrying, setRetrying] = useState(false);
  const activeProvider = useMemo(() => editor?.kind === "edit" ? editor.draft.id : null, [editor]);
  const saved = async (report?: ProviderReloadResult) => {
    if (report) setReload(report);
    await load();
    // Persistence already succeeded; a disconnected active view must not turn
    // this into a misleading "save failed" result or hide the retry report.
    try { await onChanged?.(); }
    catch { setError("配置已保存，但当前页面信息未刷新，请重新打开会话。"); }
  };
  const retry = async () => {
    if (!reload || retrying) return;
    setRetrying(true); setError(null);
    try {
      const result = await api.reloadProviders(reload.failures.map((failure) => failure.sessionId));
      await saved({ ...result, applied: [...new Set([...reload.applied, ...result.applied])] });
    } catch (value) { setError(value instanceof Error ? value.message : "无法重新加载配置"); }
    finally { setRetrying(false); }
  };
  const firstPreset = presets[0];
  return <section className="provider-settings-panel">
    <h2>模型</h2>
    <p className="provider-settings-copy">API 提供方使用 API Key；ChatGPT 订阅会自动读取本机 Codex 登录状态。</p>
    {loading && !providers.length && <div className="settings-empty">正在读取提供方…</div>}
    {error && <p className="form-error">{error}</p>}
    {reload && <ProviderReloadNotice report={reload} retrying={retrying} onRetry={() => void retry()} />}
    <div className="provider-list" role="list">
      {providers.map((provider) => <div className={`provider-card ${activeProvider === provider.id ? "editing" : ""}`}
        role="listitem" key={provider.id}>
        <div className="provider-summary"><div className="provider-summary-copy"><div><strong>{provider.name}</strong>
          <span className={`provider-status ${provider.authStatus === "configured" ? "configured" : ""}`} role="img"
            aria-label={providerAuthSummary(provider)} /></div><small>{providerAuthSummary(provider)}</small></div>
          <button type="button" className="provider-edit-button" aria-label={`编辑 ${provider.name} (${provider.id})`}
            onClick={() => setEditor({ kind: "edit", draft: draftFromProvider(provider), advanced: false,
              apiKeyConfigured: provider.apiKeyConfigured, provider })}>{provider.authType === "chatgpt-subscription" ? "查看" : "编辑"}</button></div>
        {activeProvider === provider.id && editor && <ProviderEditor editor={editor} presets={presets}
          onEditor={setEditor} onSaved={saved} />}
      </div>)}
    </div>
    {!activeProvider && editor && <ProviderEditor editor={editor} presets={presets}
      onEditor={setEditor} onSaved={saved} />}
    {!editor && <div className="provider-add-actions">
      <button type="button" disabled={!firstPreset} onClick={() => firstPreset && setEditor({
        kind: "preset", draft: draftFromPreset(firstPreset), advanced: false,
      })}><Icon name="plus" />添加提供方</button>
      <button type="button" onClick={() => setEditor({ kind: "custom", draft: customDraft(), advanced: true })}>
        <Icon name="plus" />添加自定义提供方
      </button>
    </div>}
  </section>;
}
