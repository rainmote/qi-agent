import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "./api";
import { BrandMark } from "./BrandMark";
import { Icon } from "./icons";
import type { Interaction, ModelEntry, RuntimeStatus, Workspace } from "./types";

function DialogFrame({ title, children, onClose, className = "", dangerous = false }: {
  title: string; children: ReactNode; onClose?: () => void; className?: string; dangerous?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => dialog.current?.querySelector<HTMLElement>("button, input, select")?.focus(), []);
  const trap = (event: KeyboardEvent) => {
    if (event.key === "Escape" && onClose) onClose();
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return <div className="dialog-backdrop" role="presentation">
    <div className={`dialog ${dangerous ? "dialog-danger" : ""} ${className}`} role="dialog" aria-modal="true"
      aria-label={title} ref={dialog} onKeyDown={trap}>
      <header><h2>{title}</h2>{onClose &&
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><Icon name="x" /></button>}</header>
      {children}
    </div>
  </div>;
}

export function ApprovalDialog({ interaction, resolving, onResolve }: {
  interaction: Interaction; resolving: boolean;
  onResolve: (decision: "allow" | "allow-session" | "deny") => void;
}) {
  return <DialogFrame title={interaction.title || "允许执行此操作？"} dangerous>
    <div className="approval-symbol"><Icon name="shield" /></div>
    <p className="dialog-copy">代理需要你的确认才能继续。请核对目标和参数。</p>
    <pre className="approval-detail">{interaction.message}</pre>
    <div className="dialog-actions approval-actions">
      <button type="button" className="button ghost" disabled={resolving} onClick={() => onResolve("deny")}>拒绝</button>
      <button type="button" className="button secondary" disabled={resolving}
        onClick={() => onResolve("allow-session")}>本会话允许</button>
      <button type="button" className="button primary" disabled={resolving} onClick={() => onResolve("allow")}>仅允许一次</button>
    </div>
  </DialogFrame>;
}

export function WorkspaceDialog({ initialPath, onClose, onSelect }: {
  initialPath?: string; onClose: () => void; onSelect: (path: string) => Promise<void>;
}) {
  const [path, setPath] = useState(initialPath || "");
  const [listing, setListing] = useState<{ path: string; parent: string | null; directories: Array<{ name: string; path: string }> } | null>(null);
  const [busy, setBusy] = useState(false);
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
      <label>文件夹路径<input aria-label="文件夹路径" value={path} onChange={(event) => setPath(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void browse(path); }} /></label>
      <div className="directory-toolbar">
        <button type="button" className="button ghost compact-button" disabled={!listing?.parent || busy}
          onClick={() => void browse(listing?.parent || undefined)}>上一级</button>
        <span>{listing?.path || "正在读取…"}</span>
      </div>
      <div className="directory-list" role="listbox" aria-label="文件夹">
        {listing?.directories.map((directory) => <button type="button" key={directory.path}
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

export function SettingsDialog({ workspaces, runtime, models, theme, onThemeChange, onClose,
  onAddWorkspace, onRemoveWorkspace }: {
  workspaces: Workspace[]; runtime: RuntimeStatus | null;
  models: { current: ModelEntry | null; providers: ModelEntry[] } | null;
  theme: "dark" | "light" | "system"; onThemeChange: (theme: "dark" | "light" | "system") => void;
  onClose: () => void; onAddWorkspace: () => void;
  onRemoveWorkspace?: (workspace: Workspace) => Promise<void>;
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
        <div className="settings-brand"><BrandMark /><strong>DAO</strong></div>
        {tabs.map((entry) => <button type="button" key={entry.id} className={tab === entry.id ? "active" : ""}
          onClick={() => setTab(entry.id)}><Icon name={entry.icon} />{entry.label}</button>)}
      </nav>
      <div className="settings-content">
        {tab === "general" && <>
          <section><h3>外观</h3><p>选择界面的明暗模式。</p>
            <div className="theme-options">{(["system", "light", "dark"] as const).map((value) =>
              <button type="button" key={value} className={theme === value ? "active" : ""}
                onClick={() => onThemeChange(value)}><Icon name={value === "dark" ? "moon" : value === "light" ? "sun" : "sliders"} />
                {value === "system" ? "跟随系统" : value === "light" ? "浅色" : "深色"}</button>)}</div>
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
        {tab === "models" && <section><h3>模型</h3><p>当前会话可用的模型提供方。</p>
          <div className="settings-cards">{models?.providers.map((model) => <div className="settings-card" key={model.id}>
            <span className="provider-dot" /><div><strong>{model.model || model.id}</strong><span>{model.provider || model.id}</span></div>
            {models.current?.id === model.id && <em>当前</em>}
          </div>)}{!models?.providers.length && <div className="settings-empty">打开会话后显示模型。</div>}</div>
        </section>}
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
