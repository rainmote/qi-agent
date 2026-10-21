export type BrowserObservation = { lease?: string; url?: string; title?: string; revision?: number; loading?: boolean; canBack?: boolean; canForward?: boolean; unknown?: boolean; confirmed?: boolean };
export type BrowserTab = BrowserObservation & { id: string; url: string; title: string; acquisition?: string; error?: string; popup?: string };

export function browserAddress(raw: string, applicationPort: string): string {
  const value = raw.trim();
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("请输入有效的 HTTP(S) 地址");
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port === applicationPort) throw new Error("此地址不能在隔离浏览器中打开");
  return url.href;
}

export function observeBrowser(tabs: BrowserTab[], detail: unknown, port: string): BrowserTab[] {
  if (!detail || typeof detail !== "object") return tabs;
  const value = detail as { lease?: unknown; state?: unknown };
  if (typeof value.lease !== "string" || !value.state || typeof value.state !== "object") return tabs;
  const state = value.state as Record<string, unknown>;
  return tabs.map(owner => {
    if (owner.lease !== value.lease || (typeof state.revision === "number" && state.revision < (owner.revision || 0))) return owner;
    const patch: Partial<BrowserTab> = {};
    if (typeof state.url === "string" && state.url !== "about:blank") {
      try { patch.url = state.url ? browserAddress(state.url, port) : owner.url; } catch { patch.error = "页面导航地址被阻止"; }
    }
    if (typeof state.popup === "string") { try { patch.popup = browserAddress(state.popup, port); } catch { patch.error = "弹出网页地址被阻止"; } }
    if (typeof state.title === "string") patch.title = state.title.slice(0, 256);
    for (const key of ["loading", "canBack", "canForward", "confirmed"] as const) if (typeof state[key] === "boolean") patch[key] = state[key];
    // UNKNOWN is sticky for this lease. Normal observations cannot authorize
    // redisplay; confirmed cleanup followed by a new lease is the recovery.
    if (state.unknown === true) patch.unknown = true;
    if (owner.unknown || patch.unknown) patch.loading = false;
    if (typeof state.revision === "number" && Number.isSafeInteger(state.revision) && state.revision >= 0) patch.revision = state.revision;
    if (typeof state.error === "string") { patch.error = state.error; patch.loading = false; }
    return { ...owner, ...patch };
  });
}

export function settleBrowser(tabs: BrowserTab[], id: string, incarnation: number, currentIncarnation: number,
  result: BrowserObservation, acquisition: string | undefined, fallbackUrl?: string): BrowserTab[] {
  if (incarnation !== currentIncarnation) return tabs;
  return tabs.map(item => item.id !== id || item.unknown ? item : {
    ...item, lease: result.lease || item.lease, acquisition: acquisition || item.acquisition,
    url: item.revision && item.revision > (result.revision ?? -1) ? item.url : result.url || fallbackUrl || item.url,
    error: undefined, ...(typeof result.revision === "number" && result.revision >= (item.revision || 0) ? result : {}),
  });
}
