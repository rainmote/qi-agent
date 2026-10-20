import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { Icon } from "./icons";
import { PermissionControl, SettingsLanguageControl, useComposerPopover } from "./ComposerControls";
import { MenuSurface } from "./MenuSurface";
import type { PolicyStatus } from "./types";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import type { Interaction, ProjectTrust, RuntimeStatus, Workspace } from "./types";
import { collapseTimings, transcriptViews, type CollapseTiming, type TranscriptView } from "./transcript-display";

function DialogFrame({ title, children, onClose, className = "", dangerous = false }: {
  title: string; children: ReactNode; onClose?: () => void; className?: string; dangerous?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const controls = () => [...dialog.current?.querySelectorAll<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary") || []]
    .filter(element => element.getClientRects().length > 0);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    const overflow = document.body.style.overflow;
    if (root) root.inert = true;
    document.body.style.overflow = "hidden";
    controls()[0]?.focus();
    return () => {
      if (root) root.inert = wasInert;
      document.body.style.overflow = overflow;
      const box = opener?.getBoundingClientRect();
      if (opener?.isConnected && box && box.right > 0 && box.left < innerWidth) opener.focus();
      else root?.querySelector<HTMLElement>(".sidebar-settings")?.focus();
    };
  }, []);
  const trap = (event: KeyboardEvent) => {
    if (event.key === "Escape" && onClose) { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = controls();
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const content = <div className="dialog-backdrop" role="presentation">
    <div className={`dialog ${dangerous ? "dialog-danger" : ""} ${className}`} role="dialog" aria-modal="true"
      aria-label={title} ref={dialog} onKeyDown={trap}>
      <header><h2>{title}</h2>{onClose &&
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="x" /></button>}</header>
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
  return <section className="approval-panel" aria-label="待确认操作" aria-busy={resolving || stopping || false}>
    <header className="approval-heading" role="status"><Icon name="shield" />
      <strong>{interaction.title || "允许执行此操作？"}</strong><span>{resolving ? "正在提交…" : count > 1 ? `${count} 项待确认` : "等待确认"}</span></header>
    <pre className="approval-detail" tabIndex={0} aria-label="操作详情">{interaction.message}</pre>
    {(stopError || error) && <p className="approval-error" role="alert">{stopError || error}</p>}
    <div className="approval-actions">
      {onStop && <button type="button" className="button ghost" disabled={stopping} onClick={onStop}>
        {stopping ? "正在停止…" : "停止运行"}</button>}
      <button type="button" className="button ghost" disabled={resolving || stopping} onClick={() => onResolve("deny")}>拒绝</button>
      {interaction.items?.some(item => item.value === "allow-session") && <button type="button" className="button secondary" disabled={resolving || stopping}
        onClick={() => onResolve("allow-session")}>本会话允许</button>}
      <button type="button" className="button primary" disabled={resolving || stopping} onClick={() => onResolve("allow")}>仅允许一次</button>
    </div>
  </section>;
}

export function ProjectTrustDialog({ trust, busy, error, onChoose }: {
  trust: ProjectTrust; busy: boolean; error: string | null;
  onChoose: (decision: "allow" | "deny" | null) => void;
}) {
  return <DialogFrame title="是否信任这个项目？" onClose={busy ? undefined : () => onChoose(null)}>
    <p className="dialog-copy">开始前，请确认你了解这个目录中的文件和指令来源。</p>
    <pre className="approval-detail trust-path">{trust.root}</pre>
    <p className="dialog-copy">信任后可加载项目资源并执行需要信任的命令；操作仍遵循当前访问权限。选择保持受限将继续禁用这些能力。</p>
    {trust.mutable === false && <p className="dialog-copy">当前配置固定了信任状态，无法在这里修改。</p>}
    {error && <p className="dialog-copy form-error" role="alert">{error}</p>}
    <div className="dialog-actions trust-actions">
      <button type="button" className="button ghost" disabled={busy} onClick={() => onChoose(null)}>取消</button>
      <button type="button" className="button secondary" disabled={busy} onClick={() => onChoose("deny")}>保持受限</button>
      <button type="button" className="button primary" disabled={busy || trust.mutable === false} onClick={() => onChoose("allow")}>
        {busy ? "正在确认…" : "信任并继续"}</button>
    </div>
  </DialogFrame>;
}

export function FullAccessDialog({ onClose, onConfirm }: {
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return <DialogFrame title="确认启用 Full Access？" onClose={onClose}
    className="full-access-dialog" dangerous>
    <div className="full-access-warning">
      <span><Icon name="shieldAlert" /></span>
      <div><strong>这会扩大代理的操作范围</strong>
        <p>代理将能修改工作区外的文件、执行敏感操作和外部命令。仅在你信任当前任务与项目内容时启用。</p></div>
    </div>
    <label className="full-access-ack">
      <input type="checkbox" checked={acknowledged}
        onChange={(event) => setAcknowledged(event.target.checked)} />
      <span>我已了解风险，并愿意继续</span>
    </label>
    <div className="dialog-actions">
      <button type="button" className="button ghost" onClick={onClose}>取消</button>
      <button type="button" className="button danger-button" disabled={!acknowledged}
        onClick={onConfirm}>启用 Full Access</button>
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
    catch (value) { setError(value instanceof Error ? value.message : "无法打开目录"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void browse(initialPath); }, []);
  const add = async () => {
    if (!path.trim()) return;
    setBusy(true); setError(null);
    try { await onSelect(path.trim()); onClose(); }
    catch (value) { setError(value instanceof Error ? value.message : "无法添加工作区"); setBusy(false); }
  };
  return <DialogFrame title="添加工作区" onClose={onClose} className="workspace-dialog">
    <div className="workspace-picker">
      <label>文件夹路径<input aria-label="文件夹路径" value={path} disabled={busy} onChange={(event) => setPath(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void browse(path); }} /></label>
      <div className="directory-toolbar">
        <button type="button" className="button ghost compact-button" disabled={!listing?.parent || busy}
          onClick={() => void browse(listing?.parent || undefined)}>上一级</button>
        <span>{listing?.path || "正在读取…"}</span>
      </div>
      <div className="directory-list" role="listbox" aria-label="文件夹">
        {listing?.directories.map((directory) => <button type="button" key={directory.path} disabled={busy}
          onDoubleClick={() => void browse(directory.path)} onClick={() => setPath(directory.path)}>
          <Icon name="folder" /><span>{directory.name}</span><Icon name="chevron" />
        </button>)}
        {!busy && listing?.directories.length === 0 && <div className="directory-empty">没有子文件夹</div>}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
    <div className="dialog-actions">
      <button type="button" className="button ghost" onClick={onClose}>取消</button>
      <button type="button" className="button primary" disabled={busy || !path.trim()} onClick={() => void add()}>添加工作区</button>
    </div>
  </DialogFrame>;
}

type SettingsTab = "general" | "models" | "plugins" | "tools" | "workspaces";

function ContentFontControl() {
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
      <input type="number" min={10} max={22} aria-label="会话字号" value={draft}
        onChange={event => { setDraft(event.target.value); apply(Number(event.target.value)); }}
        onBlur={() => setDraft(String(size))} />
      {/* Match the reference's normal-flow value; focus reveals the existing direct editor. */}
      <span className="content-font-value" aria-hidden="true">{draft}</span>
      <span className="content-font-arrows">
        <button type="button" aria-label="增大会话字号" disabled={size >= 22} onClick={() => step(1)}><Icon name="chevronUp" /></button>
        <button type="button" aria-label="减小会话字号" disabled={size <= 10} onClick={() => step(-1)}><Icon name="chevronDown" /></button>
      </span>
    </span><span className="content-font-unit">px</span>
  </div>;
}

function SettingsPreferenceControl<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, () => setOpen(false), true, "below", true);
  return <div className="settings-preference-control" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button ref={popover.trigger} type="button" className="settings-preference-trigger" aria-label={label}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {options.find(item => item.id === value)?.label}<Icon name="chevronDown" />
    </button>
    {open && <MenuSurface ref={popover.panel} className="composer-popover settings-preference-menu" role="menu" aria-label={`${label}选项`}>
      {options.map(item => <button type="button" key={item.id} role="menuitemradio" aria-checked={item.id === value}
        onClick={() => { popover.dismiss(); onChange(item.id); }}><span>{item.label}</span>{item.id === value && <Icon name="check" />}</button>)}
    </MenuSurface>}
  </div>;
}

export function SettingsDialog({ workspaces, runtime, theme, onThemeChange, onClose, view, onViewChange, collapseTiming, onCollapseTimingChange,
  onAddWorkspace, onRemoveWorkspace, onProvidersChanged, policy, onPolicyChange }: {
  workspaces: Workspace[]; runtime: RuntimeStatus | null;
  policy?: PolicyStatus | null; onPolicyChange?: (mode: PolicyStatus["mode"]) => void;
  theme: "dark" | "light" | "system"; onThemeChange: (theme: "dark" | "light" | "system") => void;
  view: TranscriptView; onViewChange: (view: TranscriptView) => void;
  collapseTiming: CollapseTiming; onCollapseTimingChange: (timing: CollapseTiming) => void;
  onClose: () => void; onAddWorkspace: () => void;
  onRemoveWorkspace?: (workspace: Workspace) => Promise<void>;
  onProvidersChanged?: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const tabs: Array<{ id: SettingsTab; label: string; icon: "settingsGeneral" | "settingsModels" | "settingsPlugins" | "terminal" | "folderClosed" }> = [
    { id: "general", label: "通用设置", icon: "settingsGeneral" },
    { id: "models", label: "模型", icon: "settingsModels" },
    { id: "plugins", label: "插件", icon: "settingsPlugins" },
    { id: "tools", label: "工具", icon: "terminal" },
    { id: "workspaces", label: "工作区", icon: "folderClosed" },
  ];
  return <DialogFrame title="设置" onClose={onClose} className="settings-dialog">
    <div className="settings-layout">
      <nav aria-label="设置分区">
        <div className="settings-brand"><strong>设置</strong></div>
        {tabs.map((entry) => <button type="button" key={entry.id} className={tab === entry.id ? "active" : ""}
          onClick={() => setTab(entry.id)}><Icon name={entry.icon} />{entry.label}</button>)}
      </nav>
      <div className="settings-main">
      <div className="settings-header">
        <button type="button" className="icon-button settings-close" aria-label="关闭设置" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <div className="settings-content">
        {tab === "general" && <>
          <section className="settings-option-row"><div><h3>权限</h3><p>选择此会话的访问权限模式</p></div>
            {policy && onPolicyChange ? <PermissionControl policy={policy} onChange={onPolicyChange} /> : <span>打开会话后可用</span>}
          </section>
          <section className="settings-option-row"><div><h3>语言</h3></div>
            <SettingsLanguageControl />
          </section>
          <section className="settings-option-row appearance-row"><div><h3>外观</h3></div>
            <div className="theme-options">{(["light", "dark", "system"] as const).map((value) =>
              <button type="button" key={value} className={theme === value ? "active" : ""} aria-pressed={theme === value}
                onClick={() => onThemeChange(value)}><Icon name={value === "dark" ? "appearanceDark" : value === "light" ? "appearanceLight" : "appearanceSystem"} />
                {value === "system" ? "跟随系统" : value === "light" ? "浅色" : "深色"}</button>)}</div>
          </section>
          <section className="settings-option-row"><div><h3>字号大小</h3><p>仅影响会话内容的字号</p></div>
            <ContentFontControl />
          </section>
          <section className="settings-option-row settings-preference-row"><div><h3>工作步骤展示</h3><p>选择希望看到多少工具调用细节</p></div>
            <SettingsPreferenceControl label="工作步骤展示" value={view} options={transcriptViews} onChange={onViewChange} />
          </section>
          <section className="settings-option-row settings-preference-row"><div><h3>工作步骤收起时机</h3><p>选择何时自动收起工作步骤</p></div>
            <SettingsPreferenceControl label="工作步骤收起时机" value={collapseTiming} options={collapseTimings} onChange={onCollapseTimingChange} />
          </section>
        </>}
        {tab === "workspaces" && <>
          <section><div className="section-title-row"><div><h3>工作区</h3><p>管理 Web UI 可以访问的本机目录。</p></div>
            <button type="button" className="button secondary compact-button" onClick={onAddWorkspace}><Icon name="plus" />添加</button></div>
            <div className="workspace-list">{workspaces.map((workspace) => <div className="workspace-row" key={workspace.id}>
              <Icon name="folder" /><div><strong>{workspace.name}</strong><span>{workspace.path}</span></div>
              {onRemoveWorkspace && workspaces.length > 1 && <button className="icon-button compact" type="button"
                aria-label={`移除工作区 ${workspace.name}`} onClick={() => void onRemoveWorkspace(workspace)}><Icon name="x" /></button>}
            </div>)}</div>
          </section>
        </>}
        {tab === "models" && <ProviderSettingsPanel onChanged={onProvidersChanged} />}
        {tab === "plugins" && <section><h3>插件</h3><p>{runtime ? `${runtime.plugins.length} 个已加载插件` : "打开会话后显示"}</p>
          <div className="settings-cards">{runtime?.plugins.map((plugin) => <div className="settings-card" key={plugin.id}>
            <Icon name="command" /><div><strong>{plugin.id}</strong><span>{plugin.description || plugin.namespace}</span></div>
          </div>)}</div>
        </section>}
        {tab === "tools" && <section><h3>工具</h3><p>{runtime ? `${runtime.tools.length} 个模型工具` : "打开会话后显示"}</p>
          <div className="settings-cards">{runtime?.tools.map((tool) => <div className="settings-card" key={tool.name}>
            <Icon name="terminal" /><div><strong>{tool.name}</strong><span>{tool.description}</span></div>
          </div>)}</div>
        </section>}
      </div>
      </div>
    </div>
  </DialogFrame>;
}
