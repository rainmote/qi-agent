import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
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

function useComposerPopover(open: boolean, close: () => void, focusOnOpen = true) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    if (!open || !panel.current || !trigger.current) return;
    const position = () => {
      const node = panel.current, button = trigger.current;
      if (!node || !button) return;
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
      const anchor = button.getBoundingClientRect(), margin = 12, gap = 8;
      node.style.right = "auto"; node.style.bottom = "auto";
      node.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
      node.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
      const panelHeight = node.offsetHeight;
      const above = anchor.top - top - gap - margin, below = top + height - anchor.bottom - gap - margin;
      const useAbove = above >= panelHeight || above >= below;
      node.style.maxHeight = `${Math.max(0, useAbove ? above : below)}px`;
      node.style.left = `${Math.max(left + margin, Math.min(anchor.left, left + width - node.offsetWidth - margin))}px`;
      node.style.top = `${Math.max(top + margin, useAbove ? anchor.top - gap - node.offsetHeight : anchor.bottom + gap)}px`;
    };
    position();
    if (focusOnOpen) (panel.current.querySelector<HTMLElement>('input, [aria-checked="true"]')
      || panel.current.querySelector<HTMLElement>("button:not(:disabled)"))?.focus({ preventScroll: true });
    const observer = new ResizeObserver(position);
    observer.observe(panel.current); observer.observe(trigger.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open, focusOnOpen]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) closeRef.current();
    };
    const onFocus = (event: FocusEvent) => {
      if (!root.current?.contains(event.target as Node)) closeRef.current();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault(); closeRef.current(); trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!open || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    const input = event.target instanceof HTMLInputElement;
    const group = (event.target as HTMLElement).closest('[role="radiogroup"]');
    if (!["ArrowDown", "ArrowUp", "Home", "End", ...(group ? ["ArrowLeft", "ArrowRight"] : [])].includes(event.key)
      || (input && ["Home", "End"].includes(event.key))) return;
    const items = [...(group || panel.current)!.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]:not(:disabled), button[role="menuitemradio"]:not(:disabled), button[role="radio"]:not(:disabled)')];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : index < 0 ? (forward ? 0 : items.length - 1) : (index + (forward ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const dismiss = () => { closeRef.current(); trigger.current?.focus(); };
  return { root, trigger, panel, onKeyDown, dismiss };
}

export function ComposerTools({ actions }: {
  actions: Array<{ label: string; icon: IconName; disabled?: boolean; run: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, () => setOpen(false));
  const id = useId();
  return <div className="composer-control composer-tools" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button ref={popover.trigger} type="button" className="toolbar-button" aria-label="添加附件与工具" title="附件、引用与工作台"
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}><Icon name="plus" /></button>
    {open && <div ref={popover.panel} id={id} className="composer-popover composer-tools-menu" role="menu" aria-label="附件与工具">
      {actions.map(action => <button type="button" role="menuitem" key={action.label} disabled={action.disabled}
        onClick={() => { popover.dismiss(); action.run(); }}><Icon name={action.icon} /><span>{action.label}</span></button>)}
    </div>}
  </div>;
}

export function PermissionControl({ policy, onChange }: {
  policy: PolicyStatus;
  onChange: (mode: PolicyStatus["mode"]) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const popover = useComposerPopover(open, close);
  const menuId = useId();
  const current = permissionMeta[policy.mode];
  const modes = policy.modes.length ? policy.modes : [{ id: "deny" as const, label: "Read Only" }];
  return <div className="composer-control permission-control" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button ref={popover.trigger} type="button" className="composer-control-trigger permission-trigger"
      aria-label={`访问权限：${current.label}`} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)}>
      <Icon name={current.icon} /><span>{current.label}</span><Icon name="chevron" />
    </button>
    {open && <div ref={popover.panel} id={menuId} className="composer-popover permission-menu" role="menu" aria-label="访问权限">
      <div className="composer-popover-title">访问权限</div>
      {modes.map((mode) => {
        const meta = permissionMeta[mode.id];
        const selected = policy.mode === mode.id;
        return <button type="button" role="menuitemradio" aria-checked={selected} key={mode.id}
          className={`permission-option ${mode.id === "allow" ? "dangerous" : ""}`}
          onClick={() => { popover.dismiss(); if (!selected) onChange(mode.id); }}>
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

export function matchingModels(models: ModelEntry[], query: string): ModelEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return models.filter(model => {
    const label = `${model["display-name"] || ""} ${model.model || ""} ${model.id}`.toLocaleLowerCase();
    return terms.every(term => label.includes(term));
  });
}

export function ModelControl({ models, selectedId, thinkingLevel, onSelectModel, onSelectThinking }: {
  models: ModelEntry[];
  selectedId: string | null;
  thinkingLevel?: string | null;
  onSelectModel: (id: string) => void;
  onSelectThinking: (level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const close = () => { setOpen(false); setQuery(""); };
  const popover = useComposerPopover(open, close);
  const menuId = useId();
  const current = models.find((entry) => entry.id === selectedId) || models[0];
  if (!current) return null;
  const levels = current["thinking-levels"] || [];
  const level = thinkingLevel || current["thinking-level"] || levels[levels.length - 1];
  const name = current["display-name"] || current.model || current.id;
  const filtered = matchingModels(models, query);
  return <div className="composer-control model-control" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button ref={popover.trigger} type="button" className="composer-control-trigger model-trigger"
      aria-label={`模型：${name}${level ? `，推力 ${effortLabel(level)}` : ""}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close() : setOpen(true)}>
      <span className="model-trigger-name">{name}</span>
      {level && <span className="model-trigger-effort">{effortLabel(level)}</span>}
      <Icon name="chevron" />
    </button>
    {open && <div ref={popover.panel} id={menuId} className="composer-popover model-menu" role="dialog" aria-label="模型与推力强度">
      {models.length > 4 && <div className="model-search"><Icon name="search" /><input type="search" value={query}
        aria-label="搜索模型" placeholder="搜索模型…" onChange={event => setQuery(event.target.value)} /></div>}
      <div className="composer-popover-title">模型</div>
      <div className="model-options" role="menu" aria-label="选择模型">
        {filtered.map((model) => {
          const selected = model.id === current.id;
          return <button type="button" role="menuitemradio" aria-checked={selected} key={model.id}
            onClick={() => { popover.dismiss(); if (!selected) onSelectModel(model.id); }}>
            <span>{model["display-name"] || model.model || model.id}</span>{selected && <Icon name="check" />}
          </button>;
        })}
      </div>
      {!filtered.length && <p className="model-empty" role="status">没有匹配的模型</p>}
      {!!levels.length && <div className="effort-section">
        <div className="composer-popover-title">推力强度</div>
        <div className="effort-options" role="radiogroup" aria-label="推力强度">
          {levels.map((entry) => <button type="button" role="radio" aria-checked={entry === level}
            className={entry === level ? "selected" : ""} key={entry}
            onClick={() => { popover.dismiss(); if (entry !== level) onSelectThinking(entry); }}>
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
  const popover = useComposerPopover(open, close, false);
  const panelId = useId();
  const percent = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
  const usageDescription = Number.isFinite(status.used_tokens) && status.used_tokens >= 0
    && Number.isFinite(status.context_window) && status.context_window > 0
    ? `${status.used_tokens.toLocaleString("zh-CN", { maximumFractionDigits: 0 })} / ${status.context_window.toLocaleString("zh-CN", { maximumFractionDigits: 0 })} tokens`
    : "上下文用量未知";
  return <div className="composer-control context-control" ref={popover.root}>
    <button ref={popover.trigger} type="button" className="context-trigger" aria-label={`上下文已用 ${percent}%`}
      aria-description={usageDescription}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => setOpen((value) => !value)}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="context-ring-track" cx="12" cy="12" r="8.5" pathLength="100" />
        <circle className="context-ring-value" cx="12" cy="12" r="8.5" pathLength="100"
          strokeDasharray={`${percent} 100`} />
      </svg>
    </button>
    {open && <div ref={popover.panel} id={panelId} className="composer-popover context-popover" role="dialog" aria-label="上下文占用">
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
