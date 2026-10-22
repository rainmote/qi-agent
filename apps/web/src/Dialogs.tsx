import { uiText as t } from "./i18n";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { Icon } from "./icons";
import { PermissionControl, SettingsLanguageControl } from "./ComposerControls";
import { FontPreferences, SettingsPreferenceControl, WebPreferenceRows } from "./PreferenceSettings";
import { shortcutForEvent, useWebPreferences } from "./web-preferences";
import { version as webVersion } from "../../../package.json";
import type { PolicyStatus } from "./types";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import { ComputerUsePanel, type ComputerCommand } from "./ComputerUsePanel";
import type { Interaction, ProjectTrust, RuntimeStatus, Workspace } from "./types";
import { collapseTimings, transcriptViews, type CollapseTiming, type TranscriptView } from "./transcript-display";
import type { TrustIntent } from "./ProjectTrust";

export function DialogFrame({ title, children, onClose, className = "", dangerous = false, initialFocus }: {
  title: string; children: ReactNode; onClose?: () => void; className?: string; dangerous?: boolean; initialFocus?: string;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const lastControl = useRef<HTMLElement | null>(null);
  const controls = () => [...dialog.current?.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary") || []]
    .filter(element => element.getClientRects().length > 0);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    const overflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    (initialFocus ? dialog.current?.querySelector<HTMLElement>(initialFocus) : null)?.focus();
    if (!initialFocus || !dialog.current?.contains(document.activeElement)) (controls()[0] || dialog.current)?.focus();
    return () => {
      if (root) root.inert = wasInert;
      document.body.style.overflow = overflow;
      const box = opener?.getBoundingClientRect();
      if (opener?.isConnected && box && box.right > 0 && box.left < innerWidth) opener.focus();
      else root?.querySelector<HTMLElement>(".sidebar-settings")?.focus();
    };
  }, []);
  useLayoutEffect(() => {
    const box = dialog.current, focused = document.activeElement;
    if (!box) return;
    const previous = lastControl.current;
    if (focused === box && previous?.isConnected && !previous.matches(":disabled") && box.contains(previous)) {
      previous.focus();
    } else if (focused instanceof HTMLElement && focused.matches(":disabled") && box.contains(focused)) {
      (controls()[0] || box).focus();
    } else if (focused === document.body && previous && !previous.isConnected) {
      (controls()[0] || box).focus();
    } else if (!controls().length && !box.contains(focused)) {
      box.focus();
    }
  });
  const trap = (event: KeyboardEvent) => {
    if (event.key === "Escape" && onClose) { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = controls();
    if (!focusable.length) { event.preventDefault(); dialog.current.focus(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
  };
  const content = <div className="dialog-backdrop" role="presentation">
    <div className={`dialog ${dangerous ? "dialog-danger" : ""} ${className}`} role="dialog" aria-modal="true"
      aria-label={title} ref={dialog} tabIndex={-1} onKeyDown={trap}
      onFocusCapture={event => { if (event.target !== dialog.current && event.target instanceof HTMLElement) lastControl.current = event.target; }}>
      <header><h2>{title}</h2>{onClose &&
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("关闭")}><Icon name="x" /></button>}</header>
      {children}
    </div>
  </div>;
  return typeof document === "undefined" ? content : createPortal(content, document.body);
}

export function ApprovalPanel({ interaction, resolving, onResolve, onStop, stopping, stopError, error, count = 1 }: {
  interaction: Interaction; resolving: boolean;
  onResolve: (decision: "allow" | "allow-session" | "deny") => void;
  onStop?: () => void; stopping?: boolean; stopError?: string | null;
  error?: string | null; count?: number;
}) {
  const choiceLabel = (value: string, fallback: string) => interaction.items?.find(item => item.value === value)?.label || t(fallback);
  return <section className="approval-panel" aria-label={t("待确认操作")} aria-busy={resolving || stopping || false}>
    <header className="approval-heading" role="status"><Icon name="shield" />
      <strong>{interaction.title || t("允许执行此操作？")}</strong><span>{resolving ? t("正在提交…") : count > 1 ? t("{0} 项待确认", count) : t("等待确认")}</span></header>
    <pre className="approval-detail" tabIndex={0} aria-label={t("操作详情")}>{interaction.message}</pre>
    {(stopError || error) && <p className="approval-error" role="alert">{stopError || error}</p>}
    <div className="approval-actions">
      {onStop && <button type="button" className="button ghost" disabled={stopping} onClick={onStop}>
        {stopping ? t("正在停止…") : t("停止运行")}</button>}
      <button type="button" className="button ghost" disabled={resolving || stopping} onClick={() => onResolve("deny")}>{choiceLabel("deny", "拒绝")}</button>
      {interaction.items?.some(item => item.value === "allow-session") && <button type="button" className="button secondary" disabled={resolving || stopping}
        onClick={() => onResolve("allow-session")}>{choiceLabel("allow-session", "本会话允许")}</button>}
      {(!interaction.items || interaction.items.some(item => item.value === "allow")) &&
        <button type="button" className="button primary" disabled={resolving || stopping} onClick={() => onResolve("allow")}>{choiceLabel("allow", "仅允许一次")}</button>}
    </div>
  </section>;
}

export function ProjectTrustDialog({ trust, intent, loading, busy, error, onChoose, onRetry }: {
  trust: ProjectTrust | null; intent: TrustIntent; loading: boolean; busy: boolean; error: string | null;
  onChoose: (decision: "allow" | "deny" | null) => void;
  onRetry: () => void;
}) {
  const manage = intent === "manage", configured = trust?.configured, editable = configured && trust.mutable !== false;
  const inherited = configured && trust["matched-root"] && trust["matched-root"] !== trust.root;
  const state = trust?.decision === "allow" ? t("已信任") : trust?.["explicit?"] ? t("受限") : t("尚未选择");
  return <DialogFrame title={t(manage ? "项目信任" : "是否信任这个项目？")} className="project-trust-dialog"
    onClose={busy ? undefined : () => onChoose(null)} initialFocus="[data-trust-cancel]">
    <div className="trust-body" aria-busy={loading || busy}>
      {loading ? <p className="trust-reading" role="status">{t("正在核对项目信任状态…")}</p> : configured ? <>
        <p className="trust-intro">{t(manage ? "查看当前目录的信任范围。修改信任不会发送输入框中的内容。"
          : intent === "enter" ? "项目已打开，尚未运行任务。请先确认这个目录的文件和指令来源。"
            : "发送前，请确认这个目录的文件和指令来源。取消会保留草稿。")}</p>
        <section className="trust-project" aria-label={t("当前项目")}>
          <div className="trust-project-heading"><span><Icon name="folderOpen" />{t("当前项目")}</span>
            <span className="trust-state"><Icon name={trust.decision === "allow" ? "shield" : "eye"} />{state}</span></div>
          <code className="trust-path">{trust.root}</code>
          {inherited && <div className="trust-inherited"><span>{t("继承自父目录")}</span><code className="trust-path">{trust["matched-root"]}</code></div>}
        </section>
        <div className="trust-effects">
          <p>{t("信任后可加载项目资源，并允许需要信任的命令通过信任检查。保持受限将禁用这些能力。")}</p>
          <p><Icon name="shield" />{t("工具仍受当前会话权限和人工审批约束。")}</p>
          <p>{t("选择保存在本机，适用于此目录及未单独设置的子目录。")}</p>
          {manage && trust.decision === "allow" && <p>{t("撤销会将此目录设为受限，不会删除父目录设置，也不会撤回已执行的操作。")}</p>}
        </div>
        {!editable && <p className="trust-fixed" role="status">{t("当前配置固定了信任状态，无法在这里修改。")}</p>}
      </> : trust && <p className="trust-intro">{t("当前运行配置未提供项目信任管理。请以实际会话权限和审批要求为准。")}</p>}
      {error && <p className="form-error trust-error" role="alert">{error}</p>}
    </div>
    <div className="dialog-actions trust-actions">
      <button type="button" className="button ghost" data-trust-cancel disabled={busy} onClick={() => onChoose(null)}>{t(manage ? "返回" : "取消")}</button>
      {!loading && !trust && error && <button type="button" className="button secondary" onClick={onRetry}>{t("重新读取")}</button>}
      {!loading && configured && (!manage || editable && trust.decision === "allow") &&
        <button type="button" className={`button secondary ${manage ? "trust-revoke" : ""}`} disabled={busy || !editable && trust.decision !== "deny"}
          onClick={() => onChoose("deny")}>{busy ? t("正在确认…") : t(manage ? "撤销信任" : "保持受限")}</button>}
      {!loading && configured && (!manage || editable && trust.decision !== "allow") &&
        <button type="button" className="button primary" disabled={busy || !editable} onClick={() => onChoose("allow")}>
          {busy ? t("正在确认…") : t(manage ? "信任项目" : "信任并继续")}</button>}
    </div>
  </DialogFrame>;
}

export function FullAccessDialog({ onClose, onConfirm }: {
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return <DialogFrame title={t("确认启用 Full Access？")} onClose={onClose}
    className="full-access-dialog" dangerous>
    <div className="full-access-warning">
      <span><Icon name="shieldAlert" /></span>
      <div><strong>{t("这会扩大代理的操作范围")}</strong>
        <p>{t("代理将能修改工作区外的文件、执行敏感操作和外部命令。仅在你信任当前任务与项目内容时启用。")}</p></div>
    </div>
    <label className="full-access-ack">
      <input type="checkbox" checked={acknowledged}
        onChange={(event) => setAcknowledged(event.target.checked)} />
      <span>{t("我已了解风险，并愿意继续")}</span>
    </label>
    <div className="dialog-actions">
      <button type="button" className="button ghost" onClick={onClose}>{t("取消")}</button>
      <button type="button" className="button danger-button" disabled={!acknowledged}
        onClick={onConfirm}>{t("启用 Full Access")}</button>
    </div>
  </DialogFrame>;
}

export function WorkspaceDialog({ initialPath, onClose, onSelect }: {
  initialPath?: string; onClose: () => void; onSelect: (path: string) => Promise<void>;
}) {
  const [path, setPath] = useState(initialPath || "");
  const [listing, setListing] = useState<{ path: string; parent: string | null; directories: Array<{ name: string; path: string }> } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const browse = async (target?: string) => {
    setBusy(true); setError(null);
    try { const next = await api.listDirectories(target); setListing(next); setPath(next.path); }
    catch (value) { setError(value instanceof Error ? value.message : t("无法打开目录")); }
    finally { setBusy(false); }
  };
  useEffect(() => { void browse(initialPath); }, []);
  const add = async () => {
    if (!path.trim()) return;
    setBusy(true); setError(null);
    try { await onSelect(path.trim()); onClose(); }
    catch (value) { setError(value instanceof Error ? value.message : t("无法添加工作区")); setBusy(false); }
  };
  return <DialogFrame title={t("添加工作区")} onClose={onClose} className="workspace-dialog">
    <div className="workspace-picker">
      <label>{t("文件夹路径")}<input aria-label={t("文件夹路径")} value={path} disabled={busy} onChange={(event) => setPath(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void browse(path); }} /></label>
      <div className="directory-toolbar">
        <button type="button" className="button ghost compact-button" disabled={!listing?.parent || busy}
          onClick={() => void browse(listing?.parent || undefined)}>{t("上一级")}</button>
        <span>{listing?.path || t("正在读取…")}</span>
      </div>
      <div className="directory-list" role="listbox" aria-label={t("文件夹")}>
        {listing?.directories.map((directory) => <button type="button" key={directory.path} disabled={busy}
          onDoubleClick={() => void browse(directory.path)} onClick={() => setPath(directory.path)}>
          <Icon name="folder" /><span>{directory.name}</span><Icon name="chevron" />
        </button>)}
        {!busy && listing?.directories.length === 0 && <div className="directory-empty">{t("没有子文件夹")}</div>}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
    <div className="dialog-actions">
      <button type="button" className="button ghost" onClick={onClose}>{t("取消")}</button>
      <button type="button" className="button primary" disabled={busy || !path.trim()} onClick={() => void add()}>{t("添加工作区")}</button>
    </div>
  </DialogFrame>;
}

type SettingsTab = "general" | "models" | "plugins" | "tools" | "workspaces";

function ContentFontControl({ expanded, onToggle, controls }: { expanded: boolean; onToggle: () => void; controls: string }) {
  const [size, setSize] = useState(() => {
    const stored = typeof localStorage === "undefined" ? 14 : Number(localStorage.getItem("qi-agent.content-font-size"));
    return Number.isInteger(stored) && stored >= 10 && stored <= 22 ? stored : 14;
  });
  const [draft, setDraft] = useState(String(size));
  const apply = (n: number) => {
    if (!Number.isInteger(n) || n < 10 || n > 22) return;
    setSize(n);
    localStorage.setItem("qi-agent.content-font-size", String(n));
    document.body.style.setProperty("--qi-content-font-size", `${n}px`);
  };
  const step = (delta: number) => {
    const n = Math.max(10, Math.min(22, size + delta));
    setDraft(String(n)); apply(n);
  };
  return <div className="content-font-control">
    <span className="content-font-stepper">
      <input type="number" min={10} max={22} aria-label={t("会话字号")} value={draft}
        onChange={event => { setDraft(event.target.value); apply(Number(event.target.value)); }}
        onBlur={() => setDraft(String(size))} />
      {/* Match the reference's normal-flow value; focus reveals the existing direct editor. */}
      <span className="content-font-value" aria-hidden="true">{draft}</span>
      <span className="content-font-arrows">
        <button type="button" aria-label={t("增大会话字号")} disabled={size >= 22} onClick={() => step(1)}><Icon name="chevronUp" /></button>
        <button type="button" aria-label={t("减小会话字号")} disabled={size <= 10} onClick={() => step(-1)}><Icon name="chevronDown" /></button>
      </span>
    </span><span className="content-font-unit">px</span>
    <button type="button" className="font-settings-expander" aria-label={t("更多字体设置")} aria-expanded={expanded} aria-controls={controls}
      onClick={onToggle}><Icon name={expanded ? "chevronUp" : "chevronDown"} /></button>
  </div>;
}

export function SettingsDialog({ workspaces, runtime, theme, onThemeChange, onClose, view, onViewChange, collapseTiming, onCollapseTimingChange,
  onAddWorkspace, onRemoveWorkspace, onProvidersChanged, policy, onPolicyChange, onOpenShortcuts, onManagePlugins, trust, onManageTrust, initialFocus, onComputerCommand, onRefreshRuntime }: {
  workspaces: Workspace[]; runtime: RuntimeStatus | null;
  policy?: PolicyStatus | null; onPolicyChange?: (mode: PolicyStatus["mode"]) => void;
  theme: "dark" | "light" | "system"; onThemeChange: (theme: "dark" | "light" | "system") => void;
  view: TranscriptView; onViewChange: (view: TranscriptView) => void;
  collapseTiming: CollapseTiming; onCollapseTimingChange: (timing: CollapseTiming) => void;
  onClose: () => void; onAddWorkspace: () => void;
  onRemoveWorkspace?: (workspace: Workspace) => Promise<void>;
  onProvidersChanged?: () => Promise<void> | void;
  onOpenShortcuts?: () => void; onManagePlugins?: () => void;
  trust?: ProjectTrust | null; onManageTrust?: () => void;
  initialFocus?: string;
  onComputerCommand?: (command: ComputerCommand) => Promise<void>;
  onRefreshRuntime?: () => Promise<void>;
}) {
  const preferences = useWebPreferences();
  const [tab, setTab] = useState<SettingsTab>("general");
  const [fontsOpen, setFontsOpen] = useState(false);
  const [pluginQuery, setPluginQuery] = useState(""), [toolQuery, setToolQuery] = useState("");
  const matches = (query: string, ...values: Array<string | undefined>) => values.join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const plugins = runtime?.plugins.filter(plugin => matches(pluginQuery, plugin.id, plugin.namespace, plugin.description)) || [];
  const tools = runtime?.tools.filter(tool => matches(toolQuery, tool.name, tool.description)) || [];
  const tabs: Array<{ id: SettingsTab; label: string; icon: "settingsGeneral" | "settingsModels" | "settingsPlugins" | "terminal" | "folderClosed" }> = [
    { id: "general", label: t("通用设置"), icon: "settingsGeneral" },
    { id: "models", label: t("模型"), icon: "settingsModels" },
    { id: "plugins", label: t("插件"), icon: "settingsPlugins" },
    { id: "tools", label: t("工具"), icon: "terminal" },
    { id: "workspaces", label: t("工作区"), icon: "folderClosed" },
  ];
  return <DialogFrame title={t("设置")} onClose={onClose} className="settings-dialog" initialFocus={initialFocus}>
    <div className="settings-layout" onKeyDown={event => {
      if (!event.defaultPrevented && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229
        && !(event.target instanceof Element && event.target.closest('[role="menu"]'))
        && shortcutForEvent(event.nativeEvent, preferences.shortcuts) === "shortcuts") {
        event.preventDefault(); event.stopPropagation(); onOpenShortcuts?.();
      }
    }}>
      <nav aria-label={t("设置分区")} onKeyDown={event => {
        if (event.nativeEvent.isComposing || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement); if (current < 0) return;
        const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
        event.preventDefault(); buttons[index]?.focus();
      }}>
        <div className="settings-brand"><strong>{t("设置")}</strong></div>
        {tabs.map((entry) => <button type="button" key={entry.id} className={tab === entry.id ? "active" : ""} aria-current={tab === entry.id ? "page" : undefined}
          onClick={() => setTab(entry.id)}><Icon name={entry.icon} />{entry.label}</button>)}
      </nav>
      <div className="settings-main">
      <div className="settings-header">
        <button type="button" className="icon-button settings-close" aria-label={t("关闭设置")} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="settings-content">
        {tab === "general" && <>
          <section className="settings-option-row"><div><h3>{t("权限")}</h3><p>{t("选择此会话的访问权限模式")}</p></div>
            {policy && onPolicyChange ? <PermissionControl policy={policy} onChange={onPolicyChange} /> : <span>{t("打开会话后可用")}</span>}
          </section>
          <section className="settings-option-row settings-trust-row"><div><h3>{t("项目信任")}</h3>
            <p>{trust?.configured ? t(trust.decision === "allow" ? "已信任 · 工具仍需遵循权限和审批" : "受限 · 需要信任的能力已禁用") : t("查看当前项目的信任范围和限制")}</p></div>
            <button type="button" className="settings-preference-trigger" data-trust-trigger disabled={!onManageTrust} onClick={onManageTrust}>{t("管理项目信任")}</button>
          </section>
          <section className="settings-option-row"><div><h3>{t("语言")}</h3></div>
            <SettingsLanguageControl />
          </section>
          <section className="settings-option-row appearance-row"><div><h3>{t("外观")}</h3></div>
            <div className="theme-options">{(["light", "dark", "system"] as const).map((value) =>
              <button type="button" key={value} className={theme === value ? "active" : ""} aria-pressed={theme === value}
                onClick={() => onThemeChange(value)}><Icon name={value === "dark" ? "appearanceDark" : value === "light" ? "appearanceLight" : "appearanceSystem"} />
                {value === "system" ? t("跟随系统") : value === "light" ? t("浅色") : t("深色")}</button>)}</div>
          </section>
          <section className="settings-option-row"><div><h3>{t("字号大小")}</h3><p>{t("仅影响会话内容的字号")}</p></div>
            <ContentFontControl expanded={fontsOpen} onToggle={() => setFontsOpen(value => !value)} controls="font-settings-region" />
          </section>
          {fontsOpen && <div id="font-settings-region"><FontPreferences /></div>}
          <section className="settings-option-row settings-preference-row"><div><h3>{t("工作步骤展示")}</h3><p>{t("选择希望看到多少工具调用细节")}</p></div>
            <SettingsPreferenceControl label={t("工作步骤展示")} value={view} options={transcriptViews} onChange={onViewChange} />
          </section>
          <section className="settings-option-row settings-preference-row"><div><h3>{t("工作步骤收起时机")}</h3><p>{t("选择何时自动收起工作步骤")}</p></div>
            <SettingsPreferenceControl label={t("工作步骤收起时机")} value={collapseTiming} options={collapseTimings} onChange={onCollapseTimingChange} />
          </section>
          <WebPreferenceRows onOpenShortcuts={onOpenShortcuts} />
          <section className="settings-option-row"><div><h3>{t("版本")}</h3><p>qi-agent Web</p></div><span>{webVersion}</span></section>
        </>}
        {tab === "workspaces" && <>
          <section><div className="section-title-row"><div><h3>{t("工作区")}</h3><p>{t("管理 Web UI 可以访问的本机目录。")}</p></div>
            <button type="button" className="button secondary compact-button" onClick={onAddWorkspace}><Icon name="plus" />{t("添加")}</button></div>
            <div className="workspace-list">{workspaces.map((workspace) => <div className="workspace-row" key={workspace.id}>
              <Icon name="folder" /><div><strong>{workspace.name}</strong><span>{workspace.path}</span></div>
              {onRemoveWorkspace && workspaces.length > 1 && <button className="icon-button compact" type="button"
                aria-label={t("移除工作区 {0}", workspace.name)} onClick={() => void onRemoveWorkspace(workspace)}><Icon name="x" /></button>}
            </div>)}</div>
          </section>
        </>}
        {tab === "models" && <ProviderSettingsPanel onChanged={onProvidersChanged} />}
        {tab === "plugins" && <section><div className="section-title-row"><div><h3>{t("插件")}</h3><p>{runtime ? t("{0} 个已加载插件", runtime.plugins.length) : t("打开会话后显示")}</p></div>
          <button type="button" className="settings-preference-trigger" disabled={!onManagePlugins} onClick={onManagePlugins}>{t("管理插件")}</button></div>
          <input className="settings-catalog-search" type="search" aria-label={t("搜索插件")} placeholder={t("搜索插件")} value={pluginQuery} onChange={event => setPluginQuery(event.target.value)} disabled={!runtime} />
          {runtime && <p className="settings-catalog-count" role="status">{t("显示 {0} / {1} 项", plugins.length, runtime.plugins.length)}</p>}
          <div className="settings-cards">{plugins.map((plugin) => <div className="settings-card" key={plugin.id}>
            <Icon name="command" /><div><strong>{plugin.id}</strong><span>{plugin.description || plugin.namespace}</span></div>
          </div>)}</div>
          {runtime && !plugins.length && <p>{t(pluginQuery.trim() ? "没有匹配的插件" : "当前会话未加载插件")}</p>}
        </section>}
        {tab === "tools" && <section><h3>{t("工具")}</h3><p>{runtime ? t("{0} 个模型工具", runtime.tools.length) : t("打开会话后显示")}</p>
          <ComputerUsePanel status={runtime?.["computer-use"]} onCommand={onComputerCommand} onRefresh={onRefreshRuntime} />
          <input className="settings-catalog-search" type="search" aria-label={t("搜索工具")} placeholder={t("搜索工具")} value={toolQuery} onChange={event => setToolQuery(event.target.value)} disabled={!runtime} />
          {runtime && <p className="settings-catalog-count" role="status">{t("显示 {0} / {1} 项", tools.length, runtime.tools.length)}</p>}
          <div className="settings-cards">{tools.map((tool) => <div className="settings-card" key={tool.name}>
            <Icon name="terminal" /><div><strong>{tool.name}</strong><span>{tool.description}</span></div>
          </div>)}</div>
          {runtime && !tools.length && <p>{t(toolQuery.trim() ? "没有匹配的工具" : "当前会话未加载工具")}</p>}
        </section>}
      </div>
      </div>
    </div>
  </DialogFrame>;
}
