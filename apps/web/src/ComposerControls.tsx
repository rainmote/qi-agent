import { useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";
import type { ContextStatus, ModelEntry, PolicyStatus } from "./types";

const permissionMeta: Record<PolicyStatus["mode"], {
  label: string; description: string; icon: IconName;
}> = {
  deny: { label: "Read Only", description: "仅查看项目，不修改文件", icon: "eye" },
  ask: { label: "Workspace Write", description: "修改工作区前按需确认", icon: "folderEdit" },
  allow: { label: "Full Access", description: "可执行敏感操作与外部命令", icon: "shieldAlert" },
};

export function permissionIcon(mode: PolicyStatus["mode"]): IconName {
  return permissionMeta[mode].icon;
}

function usePopoverDismiss(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open]);
  return root;
}

export function PermissionControl({ policy, onChange }: {
  policy: PolicyStatus;
  onChange: (mode: PolicyStatus["mode"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const root = usePopoverDismiss(open, close);
  const menuId = useId();
  const current = permissionMeta[policy.mode];
  const modes = policy.modes.length ? policy.modes : [{ id: "deny" as const, label: "Read Only" }];
  return <div className="composer-control permission-control" ref={root}>
    <button type="button" className="composer-control-trigger permission-trigger"
      aria-label={`访问权限：${current.label}`} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)}>
      <Icon name={current.icon} /><span>{current.label}</span><Icon name="chevron" />
    </button>
    {open && <div id={menuId} className="composer-popover permission-menu" role="menu" aria-label="访问权限">
      <div className="composer-popover-title">访问权限</div>
      {modes.map((mode) => {
        const meta = permissionMeta[mode.id];
        const selected = policy.mode === mode.id;
        return <button type="button" role="menuitemradio" aria-checked={selected} key={mode.id}
          className={`permission-option ${mode.id === "allow" ? "dangerous" : ""}`}
          onClick={() => { close(); if (!selected) onChange(mode.id); }}>
          <span className="permission-option-icon"><Icon name={meta.icon} /></span>
          <span className="permission-option-copy"><strong>{mode.label || meta.label}</strong><small>{meta.description}</small></span>
          <span className="permission-option-check">{selected && <Icon name="check" />}</span>
        </button>;
      })}
    </div>}
  </div>;
}

const effortLabels: Record<string, string> = {
  off: "Off", low: "Low", medium: "Medium", high: "High", max: "Max",
};

export function effortLabel(level?: string | null): string {
  if (!level) return "";
  return effortLabels[level] || `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

export function ModelControl({ models, selectedId, thinkingLevel, onSelectModel, onSelectThinking }: {
  models: ModelEntry[];
  selectedId: string | null;
  thinkingLevel?: string | null;
  onSelectModel: (id: string) => void;
  onSelectThinking: (level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const root = usePopoverDismiss(open, close);
  const menuId = useId();
  const current = models.find((entry) => entry.id === selectedId) || models[0];
  if (!current) return null;
  const levels = current["thinking-levels"] || [];
  const level = thinkingLevel || current["thinking-level"] || levels[levels.length - 1];
  const name = current["display-name"] || current.model || current.id;
  return <div className="composer-control model-control" ref={root}>
    <button type="button" className="composer-control-trigger model-trigger"
      aria-label={`模型：${name}${level ? `，推力 ${effortLabel(level)}` : ""}`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen((value) => !value)}>
      <span className="model-trigger-name">{name}</span>
      {level && <span className="model-trigger-effort">{effortLabel(level)}</span>}
      <Icon name="chevron" />
    </button>
    {open && <div id={menuId} className="composer-popover model-menu" role="menu" aria-label="模型与推力强度">
      <div className="composer-popover-title">模型</div>
      <div className="model-options">
        {models.map((model) => {
          const selected = model.id === current.id;
          return <button type="button" role="menuitemradio" aria-checked={selected} key={model.id}
            onClick={() => { close(); if (!selected) onSelectModel(model.id); }}>
            <span>{model["display-name"] || model.model || model.id}</span>{selected && <Icon name="check" />}
          </button>;
        })}
      </div>
      {!!levels.length && <div className="effort-section">
        <div className="composer-popover-title">推力强度</div>
        <div className="effort-options" role="radiogroup" aria-label="推力强度">
          {levels.map((entry) => <button type="button" role="radio" aria-checked={entry === level}
            className={entry === level ? "selected" : ""} key={entry}
            onClick={() => { close(); if (entry !== level) onSelectThinking(entry); }}>
            {effortLabel(entry)}
          </button>)}
        </div>
      </div>}
    </div>}
  </div>;
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(value >= 100_000 ? 0 : 1))}K`;
  return String(value);
}

export function ContextMeter({ status }: { status: ContextStatus }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const root = usePopoverDismiss(open, close);
  const panelId = useId();
  const percent = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
  return <div className="composer-control context-control" ref={root}>
    <button type="button" className="context-trigger" aria-label={`上下文已用 ${percent}%`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => setOpen((value) => !value)}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="context-ring-track" cx="12" cy="12" r="8.5" pathLength="100" />
        <circle className="context-ring-value" cx="12" cy="12" r="8.5" pathLength="100"
          strokeDasharray={`${percent} 100`} />
      </svg>
    </button>
    {open && <div id={panelId} className="composer-popover context-popover" role="dialog" aria-label="上下文占用">
      <div className="context-popover-head"><div><strong>上下文</strong><span>已用 {percent}%</span></div>
        <b>{formatTokenCount(status.used_tokens)} <small>/ {formatTokenCount(status.context_window)}</small></b></div>
      <div className="context-progress"><span style={{ width: `${percent}%` }} /></div>
      <div className="context-breakdown">
        <span><i className="system" />系统指令<strong>{formatTokenCount(status.system_tokens)}</strong></span>
        <span><i className="tools" />工具定义<strong>{formatTokenCount(status.tool_tokens)}</strong></span>
        <span><i className="messages" />会话消息<strong>{formatTokenCount(status.message_tokens)}</strong></span>
      </div>
      <p>根据当前模型可见内容估算，实际计费量可能略有差异。</p>
    </div>}
  </div>;
}
