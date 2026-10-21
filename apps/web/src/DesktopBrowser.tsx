import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { browserAddress, observeBrowser, settleBrowser, type BrowserObservation, type BrowserTab } from "./browser-session";
import { uiText as t } from "./i18n";

declare global { interface Window { __QI_DESKTOP_BROWSER__?: boolean } }
type Bounds = { x: number; y: number; width: number; height: number };
type NativeResult = BrowserObservation;
type Tab = BrowserTab;
type NativeRequest = { id?: string; action: string; workspace: string; lease?: string; acquisition?: string; url?: string; bounds?: Bounds; visibility?: number };

// Serialize dispatch only, never completion. Visibility requests can pass a slow
// acquisition. Native monotonic visibility revisions reject any late show.
const dispatches: { run: () => void; priority: boolean }[] = [];
let dispatching = false;
function enqueue(run: () => void, priority: boolean) {
  if (priority) dispatches.unshift({ run, priority }); else dispatches.push({ run, priority });
  if (dispatching) return;
  dispatching = true;
  const step = () => { const next = dispatches.shift(); if (!next) { dispatching = false; return; } next.run(); setTimeout(step, 0); };
  setTimeout(step, 0);
}
function nativeRequest(input: NativeRequest, valid = () => true): Promise<NativeResult> {
  if (!window.__QI_DESKTOP_BROWSER__) return Promise.reject(new Error(t("浏览器需要 qi-agent 桌面版本")));
  return new Promise((resolve, reject) => enqueue(() => {
    if (!valid()) { resolve({}); return; }
    const id = input.id || crypto.randomUUID();
    let timedOut = false;
    const finish = () => { clearTimeout(timer); clearTimeout(lateTimer); window.removeEventListener("qi-browser-response", receive); };
    const receive = (event: Event) => {
      const value = (event as CustomEvent).detail;
      if (value?.id !== id) return;
      finish();
      if (timedOut) {
        if (input.action === "acquire") window.dispatchEvent(new CustomEvent("qi-browser-acquisition", { detail: {
          acquisition: id, lease: value.result?.lease || value.lease, unknown: value.uncertain === true, error: value.error,
        } }));
        return;
      }
      if (value.ok === true) resolve(value.result || {});
      else reject(Object.assign(new Error(typeof value.error === "string" ? value.error : t("浏览器请求失败")),
        { lease: typeof value.lease === "string" ? value.lease : undefined, uncertain: value.uncertain === true }));
    };
    const timer = setTimeout(() => { timedOut = true; reject(Object.assign(new Error(t("浏览器结果未确认，请清理该标签后再操作")), { uncertain: true })); }, 10_000);
    const lateTimer = setTimeout(finish, 60_000);
    window.addEventListener("qi-browser-response", receive);
    window.location.assign(`qi-browser://request?data=${encodeURIComponent(JSON.stringify({ ...input, id }))}`);
  }, input.action === "present" && !input.lease));
}

let presentationRevision = 0;
let browserIncarnation = 0;
let lastPresentation = "";
const presentations = new Map<string, { workspace: string; lease: string; bounds: Bounds }>();
function present(scope: string, workspace: string, value?: { lease: string; bounds: Bounds }) {
  if (value) presentations.set(scope, { workspace, ...value }); else presentations.delete(scope);
  const selected = [...presentations.values()].at(-1);
  const state = JSON.stringify(selected || {});
  if (state === lastPresentation) return;
  lastPresentation = state;
  const incarnation = browserIncarnation;
  void nativeRequest({ action: "present", workspace: selected?.workspace || workspace, lease: selected?.lease,
    bounds: selected?.bounds, visibility: ++presentationRevision }).catch(error => {
    if (incarnation !== browserIncarnation) return;
    window.dispatchEvent(new CustomEvent("qi-browser-visibility-unknown", { detail: error instanceof Error ? error.message : String(error) }));
  });
}

function address(raw: string): string {
  try { return browserAddress(raw, window.location.port); }
  catch (error) { throw new Error(t(error instanceof Error ? error.message : "请输入有效的 HTTP(S) 地址")); }
}

const blank = (): Tab => ({ id: crypto.randomUUID(), url: "", title: t("新标签") });
function storedTabs(key: string): Tab[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) || "null");
    if (!Array.isArray(saved)) return [blank()];
    const tabs = saved.slice(0, 8).flatMap(value => {
      try {
        if (!value || typeof value.url !== "string" || typeof value.title !== "string") return [];
        return [{ id: crypto.randomUUID(), url: address(value.url), title: value.title.slice(0, 256) }];
      } catch { return []; }
    });
    return tabs.length ? tabs : [blank()];
  } catch { return [blank()]; }
}

function BrowserPanel({ workspaceId, scope, visible, newTabSerial, onClose }: { workspaceId: string; scope: string; visible: boolean; newTabSerial: number; onClose: () => void }) {
  const storageKey = `qi-agent.browser-tabs.${scope}`;
  const [tabs, setTabs] = useState<Tab[]>(() => storedTabs(storageKey));
  const [active, setActive] = useState(() => tabs[0].id);
  const [input, setInput] = useState(tabs[0].url);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const surface = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const current = useRef(tabs); current.current = tabs;
  const alive = useRef(true), locked = useRef(false), blocked = useRef(false);
  const displayed = useRef(visible); displayed.current = visible;
  const tab = tabs.find(value => value.id === active) || tabs[0];
  const lastNewTab = useRef(newTabSerial);
  const update = (id: string, value: Partial<Tab>) => setTabs(items => items.map(item => item.id === id ? { ...item, ...value, unknown: item.unknown || value.unknown } : item));
  const bounds = (): Bounds => {
    const box = surface.current?.getBoundingClientRect();
    if (!box || box.width < 1 || box.height < 1) throw new Error(t("请先展开浏览器面板"));
    return { x: Math.max(0, box.x), y: Math.max(0, box.y), width: box.width, height: box.height };
  };
  const perform = async (action: string, target = tab, url?: string) => {
    if (locked.current || target.unknown) return;
    locked.current = true; setBusy(true); setNotice("");
    const incarnation = browserIncarnation;
    try {
      if (!target.lease && action !== "navigate") throw new Error(t("点击恢复或输入地址后打开网页"));
      const acquisition = target.lease ? target.acquisition : crypto.randomUUID();
      if (!target.lease) update(target.id, { acquisition });
      const result = await nativeRequest({ id: target.lease ? undefined : acquisition, action: target.lease ? action : "acquire", workspace: workspaceId,
        lease: target.lease, url, bounds: target.lease ? undefined : bounds() });
      if (!alive.current || incarnation !== browserIncarnation) {
        if (acquisition) void nativeRequest({ action: "abandon", workspace: workspaceId, acquisition }).catch(() => undefined);
        return;
      }
      setTabs(items => settleBrowser(items, target.id, incarnation, browserIncarnation, result, acquisition, url));
    } catch (error) {
      if (alive.current && incarnation === browserIncarnation) {
        const message = error instanceof Error ? error.message : String(error);
        const native = error as { lease?: string; uncertain?: boolean };
        update(target.id, { lease: native.lease || target.lease, error: message, loading: false, unknown: native.uncertain === true || message.includes("未确认") });
      }
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(tabs.filter(value => value.url).map(({ url, title }) => ({ url, title })))); }
    catch { setNotice(t("浏览器标签未保存；当前网页仍可使用")); }
  }, [tabs, storageKey]);
  useEffect(() => { setInput(tab.url); }, [tab.id, tab.url]);
  useEffect(() => {
    const incarnation = browserIncarnation;
    for (const item of tabs) if (item.lease && !item.unknown) {
      void nativeRequest({ action: "status", workspace: workspaceId, lease: item.lease }).catch(error => {
        if (alive.current && incarnation === browserIncarnation) setTabs(items => items.map(owner => owner.id === item.id && owner.lease === item.lease ? { ...owner, unknown: true, error: error instanceof Error ? error.message : String(error) } : owner));
      });
    }
  }, [tabs.map(value => value.lease || "").join(":"), workspaceId]);
  useEffect(() => {
    if (!visible) return;
    const frame = requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>(".browser-toolbar input")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  useEffect(() => {
    if (newTabSerial === lastNewTab.current) return;
    lastNewTab.current = newTabSerial;
    if (!visible || locked.current || current.current.length >= 8) return;
    const next = blank(); setTabs(items => [...items, next]); setActive(next.id);
  }, [newTabSerial, visible]);
  useEffect(() => {
    alive.current = true;
    const receive = (event: Event) => {
      setTabs(items => observeBrowser(items, (event as CustomEvent).detail, window.location.port));
    };
    const late = (event: Event) => {
      const value = (event as CustomEvent).detail;
      if (typeof value?.acquisition !== "string") return;
      setTabs(items => items.map(item => item.acquisition !== value.acquisition ? item : {
        ...item, lease: typeof value.lease === "string" ? value.lease : item.lease, unknown: true,
        error: t("获取网页曾超时；已保留身份，请先清理该标签后明确恢复"), loading: false,
      }));
    };
    const visibilityUnknown = (event: Event) => setNotice(`${String((event as CustomEvent).detail)} — ${t("显示状态未确认；请清理全部浏览器标签，失败时正常退出应用")}`);
    const cleaned = () => {
      presentations.clear(); lastPresentation = "";
      setTabs(items => items.map(({ id, url, title }) => ({ id, url, title })));
      setNotice(t("全部网页已关闭；恢复需明确选择"));
    };
    window.addEventListener("qi-browser-state", receive);
    window.addEventListener("qi-browser-acquisition", late);
    window.addEventListener("qi-browser-visibility-unknown", visibilityUnknown);
    window.addEventListener("qi-browser-cleaned", cleaned);
    return () => {
      alive.current = false; present(scope, workspaceId);
      window.removeEventListener("qi-browser-state", receive);
      window.removeEventListener("qi-browser-acquisition", late);
      window.removeEventListener("qi-browser-visibility-unknown", visibilityUnknown);
      window.removeEventListener("qi-browser-cleaned", cleaned);
      for (const value of current.current) {
        if (value.acquisition) void nativeRequest({ action: "abandon", workspace: workspaceId, acquisition: value.acquisition }).catch(() => undefined);
        else if (value.lease) void nativeRequest({ action: "release", workspace: workspaceId, lease: value.lease }).catch(() => undefined);
      }
    };
  }, [workspaceId, scope]);
  useLayoutEffect(() => {
    if (!window.__QI_DESKTOP_BROWSER__) return;
    const sync = () => {
      const ownDialog = root.current?.closest(".workbench-drawer");
      blocked.current = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"], [role="menu"], [role="listbox"]')]
        .some(element => element !== ownDialog && !root.current?.contains(element) && element.getClientRects().length > 0);
      const item = current.current.find(value => value.id === active);
      try { present(scope, workspaceId, displayed.current && !blocked.current && item?.lease && !item.unknown ? { lease: item.lease, bounds: bounds() } : undefined); }
      catch (error) { present(scope, workspaceId); setNotice(error instanceof Error ? error.message : String(error)); }
    };
    const resize = new ResizeObserver(sync);
    if (surface.current) resize.observe(surface.current);
    const overlays = new MutationObserver(sync);
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal", "hidden", "style", "class"] });
    sync();
    return () => { resize.disconnect(); overlays.disconnect(); present(scope, workspaceId); };
  }, [visible, active, tabs.map(value => `${value.lease}:${value.unknown}`).join(":"), workspaceId, scope]);

  useEffect(() => {
    if (!tab.lease || tab.unknown || tab.confirmed || !tab.url) return;
    const incarnation = browserIncarnation, started = performance.now(), lease = tab.lease;
    let stopped = false;
    const deadline = setTimeout(() => {
      if (stopped || incarnation !== browserIncarnation) return;
      stopped = true;
      update(tab.id, { unknown: true, loading: false, error: t("未收到当前导航的完成确认，网络加载结果未知。请先关闭标签，再明确恢复网页。") });
    }, 30_000);
    const poll = async () => {
      if (stopped || incarnation !== browserIncarnation) return;
      if (performance.now() - started >= 30_000) {
        update(tab.id, { unknown: true, loading: false, error: t("未收到当前导航的完成确认，网络加载结果未知。请先关闭标签，再明确恢复网页。") });
        return;
      }
      try { await nativeRequest({ action: "status", workspace: workspaceId, lease }); }
      catch (error) { if (!stopped && incarnation === browserIncarnation) update(tab.id, { unknown: true, loading: false, error: error instanceof Error ? error.message : String(error) }); return; }
      if (!stopped) timer = setTimeout(poll, 500);
    };
    let timer = setTimeout(poll, 500);
    return () => { stopped = true; clearTimeout(timer); clearTimeout(deadline); };
  }, [tab.lease, tab.id, tab.revision, tab.confirmed, tab.unknown, Boolean(tab.url), workspaceId]);

  const close = async (target: Tab) => {
    if (locked.current) return;
    locked.current = true; setBusy(true);
    const incarnation = browserIncarnation;
    try {
      if (target.acquisition) await nativeRequest({ action: "abandon", workspace: workspaceId, acquisition: target.acquisition });
      else if (target.lease) await nativeRequest({ action: "release", workspace: workspaceId, lease: target.lease });
      else if (target.unknown) throw new Error(t("关闭结果未确认，请使用清理全部浏览器标签"));
      if (incarnation !== browserIncarnation) return;
      const next = current.current.filter(value => value.id !== target.id);
      const retained = next.length ? next : [blank()]; setTabs(retained);
      if (target.id === active) setActive(retained[0].id);
    } catch (error) { if (incarnation === browserIncarnation) setNotice(error instanceof Error ? error.message : String(error)); }
    finally { locked.current = false; setBusy(false); }
  };
  useEffect(() => {
    const request = () => { const selected = current.current.find(item => item.id === active); if (visible && selected) void close(selected); };
    window.addEventListener("qi-browser-close-tab", request);
    return () => window.removeEventListener("qi-browser-close-tab", request);
  }, [visible, tab.id, tab.lease, active]);
  return <section ref={root} className="desktop-browser-panel" hidden={!visible} aria-label={t("浏览器")}>
    <header className="workbench-heading"><strong>{t("浏览器")}</strong><button type="button" onClick={onClose} aria-label={t("收起浏览器")}><Icon name="x" /></button></header>
    <div className="browser-tabs" role="tablist" aria-label={t("浏览器标签")} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !(event.target as HTMLElement).matches('[role="tab"]')) return;
      event.preventDefault();
      const index = tabs.findIndex(value => value.id === active);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      setActive(tabs[next].id); requestAnimationFrame(() => document.getElementById(`browser-tab-${tabs[next].id}`)?.focus());
    }}>
      {tabs.map(item => <div key={item.id} className={`browser-tab ${item.id === active ? "active" : ""}`}>
        <button type="button" role="tab" id={`browser-tab-${item.id}`} tabIndex={item.id === active ? 0 : -1} aria-selected={item.id === active} onClick={() => setActive(item.id)} title={item.url}>{item.loading ? "◌ " : ""}{item.title || item.url || t("新标签")}</button>
        <button type="button" aria-label={t("关闭标签")} disabled={busy} onClick={() => void close(item)}><Icon name="x" /></button>
      </div>)}
      <button type="button" disabled={busy || tabs.length >= 8} aria-label={t("新建浏览器标签")} onClick={() => { const next = blank(); setTabs(items => [...items, next]); setActive(next.id); }}><Icon name="plus" /></button>
    </div>
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); try { void perform("navigate", tab, address(input)); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); } }}>
      <button type="button" aria-label={t("后退")} disabled={!tab.lease || !tab.canBack || busy || tab.unknown} onClick={() => void perform("back")}><Icon name="chevron" className="browser-back" /></button>
      <button type="button" aria-label={t("前进")} disabled={!tab.lease || !tab.canForward || busy || tab.unknown} onClick={() => void perform("forward")}><Icon name="chevron" /></button>
      <button type="button" aria-label={t("刷新网页")} disabled={!tab.lease || busy || tab.unknown} onClick={() => void perform("reload")}><Icon name="refresh" /></button>
      <input aria-label={t("网页地址")} placeholder="https://" value={input} onChange={event => setInput(event.target.value)} autoComplete="off" spellCheck={false} />
      <button type="submit" disabled={busy || tab.unknown}>{t("前往")}</button>
      <button type="button" disabled={!tab.url || busy || tab.unknown} aria-label={t("在系统浏览器打开")} onClick={() => window.open(tab.url, "_blank", "noopener,noreferrer")}><Icon name="eye" /></button>
    </form>
    {window.__QI_DESKTOP_BROWSER__ && <div className="browser-recovery"><button type="button" disabled={busy} onClick={async () => {
      if (locked.current) return;
      locked.current = true; setBusy(true);
      try { await nativeRequest({ action: "cleanup", workspace: workspaceId }); browserIncarnation++; window.dispatchEvent(new Event("qi-browser-cleaned")); }
      catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
      finally { locked.current = false; setBusy(false); }
    }}>{t("清理全部浏览器标签")}</button></div>}
    {tab.popup && <p className="browser-notice">{t("网页请求打开新标签：")}{tab.popup} <button type="button" disabled={busy || tabs.length >= 8} onClick={() => {
      const next = { ...blank(), url: tab.popup || "" }; update(tab.id, { popup: undefined }); setTabs(items => [...items, next]); setActive(next.id);
    }}>{t("在新标签准备打开")}</button><button type="button" onClick={() => update(tab.id, { popup: undefined })}>{t("取消")}</button></p>}
    {(notice || tab.error) && <p role="status" className="browser-notice">{tab.error || notice}</p>}
    <div className="native-browser-surface" role="tabpanel" aria-labelledby={`browser-tab-${tab.id}`} ref={surface}>
      {!window.__QI_DESKTOP_BROWSER__ ? <p>{t("浏览器需要 qi-agent 桌面版本")}</p>
        : !tab.lease && <div className="browser-start"><Icon name="eye" /><h3>{tab.url ? tab.title : t("在会话旁浏览网页")}</h3><p>{t("只接受 HTTP(S)，网页与应用数据隔离。网页内容不会自动发送给模型。")}</p>
          {tab.url && <button type="button" disabled={busy || tab.unknown} onClick={() => void perform("navigate", tab, tab.url)}>{t("恢复此网页")}</button>}
        </div>}
    </div>
  </section>;
}

export function DesktopBrowser({ workspaceId, sessionId, visible, newTabSerial, onClose }: { workspaceId: string; sessionId?: string; visible: boolean; newTabSerial: number; onClose: () => void }) {
  const scope = `${workspaceId}:${sessionId || "draft"}`;
  const [panels, setPanels] = useState<{ scope: string; workspaceId: string }[]>([]);
  useEffect(() => {
    if (visible) setPanels(items => items.some(item => item.scope === scope) ? items : [...items, { scope, workspaceId }]);
  }, [visible, scope, workspaceId]);
  return <>{panels.map(panel => <BrowserPanel key={panel.scope} {...panel} newTabSerial={newTabSerial} visible={visible && panel.scope === scope} onClose={onClose} />)}</>;
}
