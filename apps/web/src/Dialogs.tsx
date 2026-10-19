import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { Icon } from "./icons";
import { ProviderSettingsPanel } from "./ProviderSettingsPanel";
import type { Interaction, ProjectTrust, RuntimeStatus, Workspace } from "./types";
import { transcriptViews, type TranscriptView } from "./transcript-display";

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
      else root?.querySelector<HTMLElement>("main .mobile-nav-button")?.focus();
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

type SettingsTab = "general" | "models" | "plugins" | "tools";

export function SettingsDialog({ workspaces, runtime, theme, onThemeChange, onClose, view, onViewChange,
  onAddWorkspace, onRemoveWorkspace, onProvidersChanged }: {
  workspaces: Workspace[]; runtime: RuntimeStatus | null;
  theme: "dark" | "light" | "system"; onThemeChange: (theme: "dark" | "light" | "system") => void;
  view: TranscriptView; onViewChange: (view: TranscriptView) => void;
  onClose: () => void; onAddWorkspace: () => void;
  onRemoveWorkspace?: (workspace: Workspace) => Promise<void>;
  onProvidersChanged?: () => Promise<void> | void;
}) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const tabs: Array<{ id: SettingsTab; label: string; icon: "settings" | "sparkles" | "command" | "terminal" }> = [
    { id: "general", label: "通用设置", icon: "settings" },
    { id: "models", label: "模型", icon: "sparkles" },
    { id: "plugins", label: "插件", icon: "command" },
    { id: "tools", label: "工具", icon: "terminal" },
  ];
  return <DialogFrame title="设置" onClose={onClose} className="settings-dialog">
    <div className="settings-layout">
      <button type="button" className="icon-button settings-close" aria-label="关闭设置" onClick={onClose}>
        <Icon name="x" />
      </button>
      <nav aria-label="设置分区">
        <div className="settings-brand"><strong>设置</strong></div>
        {tabs.map((entry) => <button type="button" key={entry.id} className={tab === entry.id ? "active" : ""}
          onClick={() => setTab(entry.id)}><Icon name={entry.icon} />{entry.label}</button>)}
      </nav>
      <div className="settings-content">
        {tab === "general" && <>
          <section className="settings-option-row"><div><h3>外观</h3><p>选择界面的明暗模式</p></div>
            <div className="theme-options">{(["light", "dark", "system"] as const).map((value) =>
              <button type="button" key={value} className={theme === value ? "active" : ""} aria-pressed={theme === value}
                onClick={() => onThemeChange(value)}><Icon name={value === "dark" ? "moon" : value === "light" ? "sun" : "sliders"} />
                {value === "system" ? "跟随系统" : value === "light" ? "浅色" : "深色"}</button>)}</div>
          </section>
          <section className="settings-option-row"><div><h3>工作步骤展示</h3><p>选择希望看到多少工具调用细节</p></div>
            <select aria-label="工作步骤展示" value={view} onChange={event => onViewChange(event.target.value as TranscriptView)}>
              {transcriptViews.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </section>
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
  </DialogFrame>;
}
