import { uiText as t } from "./i18n";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon, type IconName } from "./icons";
import { MenuSurface } from "./MenuSurface";
import { rankByName } from "./vendor/harness-rank-by-name";
import type { ContextStatus, ModelEntry, PolicyStatus } from "./types";
import { contextBudgetExplanation, contextTokenCount } from "./context-budget";
import { updateWebPreferences, useWebPreferences } from "./web-preferences";

const permissionMeta: Record<PolicyStatus["mode"], {
  label: string; displayLabel: string; description: string; icon: IconName;
}> = {
  deny: { label: "Read Only", displayLabel: "仅可查看", description: "仅查看项目，不修改文件", icon: "eye" },
  ask: { label: "Workspace Write", displayLabel: "工作区内修改", description: "修改工作区前按需确认", icon: "folderEdit" },
  allow: { label: "Full Access", displayLabel: "完全权限", description: "可执行敏感操作与外部命令", icon: "shieldAlert" },
};

export function permissionIcon(mode: PolicyStatus["mode"]): IconName {
  return permissionMeta[mode].icon;
}

export function useComposerPopover(open: boolean, close: () => void, focusOnOpen = true, placement: "auto" | "below" = "auto", alignEnd = false, gap = 4) {
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
      const anchor = button.getBoundingClientRect(), margin = 12;
      node.style.right = "auto"; node.style.bottom = "auto";
      node.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
      node.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
      const panelHeight = node.offsetHeight;
      const above = anchor.top - top - gap - margin, below = top + height - anchor.bottom - gap - margin;
      const useAbove = placement === "below" ? below < panelHeight && above > below : above >= panelHeight || above >= below;
      node.style.maxHeight = `${Math.max(0, useAbove ? above : below)}px`;
      node.style.left = `${Math.max(left + margin, Math.min(alignEnd ? anchor.right - node.offsetWidth : anchor.left, left + width - node.offsetWidth - margin))}px`;
      node.style.top = `${Math.max(top + margin, useAbove ? anchor.top - gap - node.offsetHeight : anchor.bottom + gap)}px`;
    };
    position();
    if (focusOnOpen) {
      const visible = (selector: string) => [...panel.current!.querySelectorAll<HTMLElement>(selector)]
        .find(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
      (visible('input, [aria-checked="true"]') || visible("button:not(:disabled)"))?.focus({ preventScroll: true });
    }
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
  }, [open, focusOnOpen, placement, alignEnd, gap]);
  useEffect(() => {
    if (!open) return;
    const contains = (target: EventTarget | null) => target instanceof Node
      && (root.current?.contains(target) || panel.current?.contains(target));
    const onPointerDown = (event: PointerEvent) => {
      if (!contains(event.target)) closeRef.current();
    };
    const onFocus = (event: FocusEvent) => {
      if (!contains(event.target)) closeRef.current();
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
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); closeRef.current(); trigger.current?.focus(); return;
    }
    if (event.key === "Tab") {
      closeRef.current(); trigger.current?.focus(); return;
    }
    const input = event.target instanceof HTMLInputElement;
    const group = (event.target as HTMLElement).closest('[role="radiogroup"]');
    if (!["ArrowDown", "ArrowUp", "Home", "End", ...(group ? ["ArrowLeft", "ArrowRight"] : [])].includes(event.key)
      || (input && ["Home", "End"].includes(event.key))) return;
    const items = [...(group || panel.current)!.querySelectorAll<HTMLElement>(
      'button[role="menuitem"]:not(:disabled), a[role="menuitem"][href], button[role="menuitemradio"]:not(:disabled), button[role="radio"]:not(:disabled)')]
      .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : index < 0 ? (forward ? 0 : items.length - 1) : (index + (forward ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const dismiss = () => { closeRef.current(); trigger.current?.focus(); };
  return { root, trigger, panel, onKeyDown, dismiss };
}

/** Global menu shares the same edge positioning, Escape and focus restoration as composer menus. */
export function SidebarMenu({ collapsed, onSettings, onWorkspace }: {
  collapsed: boolean; onSettings: () => void; onWorkspace: () => void;
}) {
  const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, () => setOpen(false));
  const id = useId();
  return <div className="sidebar-menu-root" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button ref={popover.trigger} className="sidebar-settings" type="button" aria-label={t("设置")} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><Icon name="more" />{!collapsed && <span>{t("更多")}</span>}</button>
    {open && <MenuSurface ref={popover.panel} id={id} className="composer-popover sidebar-global-menu" role="menu" aria-label={t("更多")}>
      <div className="menu-viewport">
      <button type="button" role="menuitem" onClick={() => { popover.dismiss(); onSettings(); }}><Icon name="settingsGeneral" /><span>{t("设置")}</span></button>
      <a role="menuitem" href="https://github.com/rainmote/qi-agent/issues" target="_blank" rel="noreferrer"><Icon name="feedback" /><span>{t("意见反馈")}</span></a>
      <button type="button" role="menuitem" onClick={() => { popover.dismiss(); onWorkspace(); }}><Icon name="folder" /><span>{t("工作区")}</span></button>
      </div>
    </MenuSurface>}
  </div>;
}

export function ComposerTools({ actions }: {
  actions: Array<{ label: string; icon: IconName; disabled?: boolean; run: () => void }>;
}) {
  const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, () => setOpen(false));
  const id = useId();
  return <div className="composer-control composer-tools" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button ref={popover.trigger} type="button" className="toolbar-button" aria-label={t("添加附件与工具")} title={t("附件、引用与工作台")}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}><Icon name="composerAdd" /></button>
    {open && <MenuSurface ref={popover.panel} id={id} className="composer-popover composer-tools-menu" role="menu" aria-label={t("附件与工具")}>
      {actions.map(action => <button type="button" role="menuitem" key={action.label} disabled={action.disabled}
        onClick={() => { popover.dismiss(); action.run(); }}><Icon name={action.icon} /><span>{action.label}</span></button>)}
    </MenuSurface>}
  </div>;
}

/** Exposes the existing session actions at the conversation header's menu seat. */
export function SessionActions({ onRename, onFork, onArchive }: {
  onRename: () => void; onFork: () => void; onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, () => setOpen(false), true, "below", true);
  const id = useId();
  const actions: Array<{ label: string; icon: IconName; run: () => void }> = [
    { label: t("重命名"), icon: "edit", run: onRename },
    { label: t("创建分支"), icon: "branch", run: onFork },
    { label: t("归档"), icon: "archive", run: onArchive },
  ];
  return <div className="session-actions-menu-root" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button type="button" ref={popover.trigger} className="session-actions-trigger" aria-label={t("更多操作")} aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}><Icon name="more" /></button>
    {open && <MenuSurface ref={popover.panel} id={id} className="composer-popover session-action-menu" role="menu" aria-label={t("会话操作")}>
      <div className="menu-viewport">
      {actions.map(action => <button key={action.label} type="button" role="menuitem"
        onClick={() => { popover.dismiss(); action.run(); }}><Icon name={action.icon} /><span>{action.label}</span></button>)}
      </div>
    </MenuSurface>}
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
      aria-label={t("访问权限：{0}", current.label)} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)}>
      <Icon name={current.icon} /><span>{t(current.displayLabel)}</span><Icon name="chevron" />
    </button>
    {open && <MenuSurface ref={popover.panel} id={menuId} className="composer-popover permission-menu" role="menu" aria-label={t("访问权限")}>
      <div className="menu-viewport">
      <div className="composer-popover-title">{t("访问权限")}</div>
      {modes.map((mode) => {
        const meta = permissionMeta[mode.id];
        const selected = policy.mode === mode.id;
        return <div className="menu-item-wrap" key={mode.id}><button type="button" role="menuitemradio" aria-checked={selected}
          title={t(meta.description)} aria-label={`${t(meta.displayLabel)}，${t(meta.description)}`} className={`permission-option ${mode.id === "allow" ? "dangerous" : ""}`}
          onClick={() => { popover.dismiss(); if (!selected) onChange(mode.id); }}>
          <span className="permission-option-icon"><Icon name={meta.icon} /></span>
          <span className="permission-option-copy">{t(meta.displayLabel)}</span>
          {selected && <span className="permission-option-check"><Icon name="check" /></span>}
        </button></div>;
      })}
      </div>
    </MenuSurface>}
  </div>;
}

export function SettingsLanguageControl() {
  const prefs = useWebPreferences();
  const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, () => setOpen(false));
  return <div className="settings-language-control" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button ref={popover.trigger} type="button" className="settings-language-trigger" aria-label={t("语言：{0}", prefs.locale === "en" ? "English" : "中文")} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(value => !value)}><span>{prefs.locale === "en" ? "English" : t("中文")}</span><Icon name="chevron" /></button>
    {open && <MenuSurface ref={popover.panel} className="composer-popover settings-language-menu" role="menu" aria-label={t("语言")}>
      {(["zh", "en"] as const).map(locale => <button type="button" role="menuitemradio" key={locale} aria-checked={prefs.locale === locale}
        onClick={() => { popover.dismiss(); updateWebPreferences({ locale }); }}>{locale === "zh" ? "中文" : "English"}{prefs.locale === locale && <Icon name="check" />}</button>)}
    </MenuSurface>}
  </div>;
}

const effortLabels: Record<string, string> = {
  off: "Off", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max",
};

export function effortLabel(level?: string | null): string {
  if (!level) return "";
  return effortLabels[level] || `${level.charAt(0).toUpperCase()}${level.slice(1)}`;
}

export function matchingModels(models: ModelEntry[], query: string): ModelEntry[] {
  if (!query.trim()) return models;
  return [...rankByName(models.map(entry => ({
    name: entry["display-name"] || entry.model || entry.id,
    label: `${entry["display-name"] || ""} ${entry.model || ""} ${entry.id}`,
    entry,
  })), query.trim())].map(match => match.entry);
}

export function ModelControl({ models, selectedId, thinkingLevel, onSelectModel, onSelectThinking }: {
  models: ModelEntry[];
  selectedId: string | null;
  thinkingLevel?: string | null;
  onSelectModel: (id: string) => void;
  onSelectThinking: (level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<"root" | "model" | "effort">("root");
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const returnPane = useRef<"model" | "effort">("model");
  const close = () => { setOpen(false); setQuery(""); setPane("root"); };
  const popover = useComposerPopover(open, close, true, "auto", true, 8);
  useLayoutEffect(() => {
    if (!open) return;
    const node = popover.panel.current;
    const target = pane === "root" ? node?.querySelector<HTMLElement>(`[data-pane="${returnPane.current}"]`)
      : node?.querySelector<HTMLElement>('input, [aria-checked="true"]') || node?.querySelector<HTMLElement>("button:not(:disabled)");
    target?.focus({ preventScroll: true });
  }, [open, pane, popover.panel]);
  const drill = (next: "model" | "effort") => {
    returnPane.current = next; setQuery(""); setHighlightedIndex(Math.max(0, models.findIndex(entry => entry.id === selectedId))); setPane(next);
  };
  const chooseModel = (model: ModelEntry) => { popover.dismiss(); if (model.id !== current.id) onSelectModel(model.id); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if ((event.key === "Escape" || (event.key === "Tab" && event.shiftKey)) && pane !== "root") {
      event.preventDefault(); event.stopPropagation(); setPane("root"); setQuery(""); return;
    }
    if (open && event.key === "Tab" && event.shiftKey) {
      event.preventDefault(); event.stopPropagation(); popover.dismiss(); return;
    }
    if (pane === "model" && models.length > 4) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); event.stopPropagation();
        if (filtered.length) setHighlightedIndex(index => (index + (event.key === "ArrowDown" ? 1 : -1) + filtered.length) % filtered.length);
        popover.panel.current?.querySelector<HTMLInputElement>("input")?.focus(); return;
      }
      if (event.target instanceof HTMLInputElement && (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey))) {
        if (event.key === "Tab" && !filtered.length) return;
        event.preventDefault(); event.stopPropagation();
        const selected = filtered[Math.min(highlightedIndex, filtered.length - 1)]; if (selected) chooseModel(selected); return;
      }
    }
    if (open && event.key === "Tab" && !event.shiftKey && event.target instanceof HTMLButtonElement
      && event.target.getAttribute("role")?.startsWith("menuitem")) {
      event.preventDefault(); event.stopPropagation(); event.target.click(); return;
    }
    popover.onKeyDown(event);
  };
  const menuId = useId();
  const current = models.find((entry) => entry.id === selectedId) || models[0];
  if (!current) return null;
  const levels = current["thinking-levels"] || [];
  const level = thinkingLevel || current["thinking-level"] || levels[levels.length - 1];
  const name = current["display-name"] || current.model || current.id;
  const filtered = matchingModels(models, query);
  return <div className="composer-control model-control" ref={popover.root} onKeyDown={onKeyDown}>
    <button ref={popover.trigger} type="button" className="composer-control-trigger model-trigger"
      aria-label={t("模型：{0}{1}", name, level ? t("，推力 {0}", effortLabel(level)) : "")}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => open ? close() : setOpen(true)}>
      <Icon name="model" className="model-trigger-icon" /><span className="model-trigger-name">{name}</span>
      {level && <span className="model-trigger-effort">{effortLabel(level)}</span>}
      <Icon name="chevron" />
    </button>
    {open && <MenuSurface ref={popover.panel} id={menuId} className="composer-popover model-menu harness-model-menu" role={pane === "model" ? "group" : "menu"} aria-label={t("模型与推力强度")}>
      {pane === "root" ? <>
        <button type="button" role="menuitem" data-pane="model" className="model-root-cell" aria-haspopup="menu"
          onClick={() => drill("model")}><span>{t("模型")}</span><span>{name}</span><Icon name="chevron" /></button>
        {!!levels.length && <button type="button" role="menuitem" data-pane="effort" className="model-root-cell" aria-haspopup="menu"
          onClick={() => drill("effort")}><span>{t("推理等级")}</span><span>{effortLabel(level)}</span><Icon name="chevron" /></button>}
      </> : pane === "model" ? <>
      {models.length > 4 && <div className="model-search"><Icon name="search" /><input type="search" value={query}
        aria-label={t("搜索模型")} aria-controls={`${menuId}-models`} aria-activedescendant={filtered.length ? `${menuId}-model-${filtered[Math.min(highlightedIndex,filtered.length - 1)].id}` : undefined}
        placeholder={t("搜索模型…")} onChange={event => { setQuery(event.target.value); setHighlightedIndex(0); }} /></div>}
      <div className="model-options" id={`${menuId}-models`} role="menu" aria-label={t("选择模型")}>
        {filtered.map((model, index) => {
          const selected = model.id === current.id;
          return <div key={model.id}>
          {model.provider && model.provider !== filtered[index - 1]?.provider && <div className="model-provider-label">{model.provider}</div>}
          <button type="button" role="menuitemradio" aria-checked={selected} id={`${menuId}-model-${model.id}`}
            className={models.length > 4 && index === highlightedIndex ? "is-active" : undefined}
            onClick={() => chooseModel(model)}>
            <span>{model["display-name"] || model.model || model.id}</span>{selected && <Icon name="check" />}
          </button></div>;
        })}
      </div>
      {!filtered.length && <p className="model-empty" role="status">{t("没有匹配的模型")}</p>}
      </> : <div className="effort-section">
        <div className="effort-options" role="radiogroup" aria-label={t("推力强度")}>
          {levels.map((entry) => <button type="button" role="radio" aria-checked={entry === level}
            className={entry === level ? "selected" : ""} key={entry}
            onClick={() => { popover.dismiss(); if (entry !== level) onSelectThinking(entry); }}>
            {effortLabel(entry)}
          </button>)}
        </div>
      </div>}
    </MenuSurface>}
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
    : t("上下文用量未知");
  return <div className="composer-control context-control" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button ref={popover.trigger} type="button" className="context-trigger" aria-label={t("上下文已用 {0}%", percent)}
      aria-description={usageDescription}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => setOpen((value) => !value)}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="context-ring-track" cx="12" cy="12" r="8.5" pathLength="100" />
        <circle className="context-ring-value" cx="12" cy="12" r="8.5" pathLength="100"
          strokeDasharray={`${percent} 100`} />
      </svg>
    </button>
    {open && <MenuSurface ref={popover.panel} id={panelId} className="composer-popover context-popover" role="dialog" aria-label={t("上下文占用")}>
      <div className="context-popover-head"><div><strong>{t("上下文")}</strong><span>{t("已用") + " "}{percent}%</span></div>
        <b>{formatTokenCount(status.used_tokens)} <small>/ {formatTokenCount(status.context_window)}</small></b></div>
      <div className="context-progress"><span style={{ width: `${percent}%` }} /></div>
      <div className="context-breakdown">
        <span><i className="system" />{t("系统指令")}<strong>{formatTokenCount(status.system_tokens)}</strong></span>
        <span><i className="tools" />{t("工具定义")}<strong>{formatTokenCount(status.tool_tokens)}</strong></span>
        <span><i className="messages" />{t("会话消息")}<strong>{formatTokenCount(status.message_tokens)}</strong></span>
        <span>{t("请求选项")}<strong>{contextTokenCount(status.option_tokens)}</strong></span>
      </div>
      <p>{contextBudgetExplanation(status)}</p>
    </MenuSurface>}
  </div>;
}
