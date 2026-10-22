import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { uiText as t } from "./i18n";
import { RequestScope } from "./request-scope";
import { createTerminalEmulator, terminalRendererAvailable, type TerminalEmulator } from "./terminal-emulator";

type TerminalState = { id?: string; terminal_id?: string; status: string; cleanup_confirmed: boolean; uncertain?: boolean; reason?: string;
  output?: string; cursor?: number; truncated?: boolean; has_more?: boolean; end?: number };
type Capability = { available: boolean; trusted: boolean; reason?: string; sandbox?: string;
  cleanup?: { mode?: string; scope?: string; descendant_containment?: boolean; limitations?: string[] };
  runtime?: { "python-version"?: string; reason?: string }; terminals: TerminalState[]; pending_request_ids?: string[] };
type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export function terminalOutputPending(state?: { status: string; uncertain?: boolean; has_more?: boolean; end?: number }, localCursor = 0): boolean {
  const unread = typeof state?.end === "number" ? localCursor < state.end : state?.has_more === true;
  return !state?.uncertain && (state?.status === "running" || (state?.status === "closed" && unread));
}

export function TerminalPanel({ sessionId, rpc, readOnly }: { sessionId: string; rpc: Rpc; readOnly: boolean }) {
  const [capability, setCapability] = useState<Capability | null>(null);
  const [active, setActive] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const [streamNotice, setStreamNotice] = useState("");
  const mounted = useRef(true), locked = useRef(false);
  const closeLock = useRef(false);
  const statusScope = useRef(new RequestScope());
  const pendingRequest = useRef<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const emulator = useRef<TerminalEmulator | null>(null);
  const currentActive = useRef(active); currentActive.current = active;
  const cursors = useRef(new Map<string, number>()), transcripts = useRef(new Map<string, string>());
  const selected = capability?.terminals.find(item => item.id === active);
  useEffect(() => { setText(""); }, [active]);
  const unknown = selected?.status === "unknown" || selected?.uncertain === true;
  const running = selected?.status === "running" && !unknown;
  const canOperate = terminalRendererAvailable && capability?.available && capability.trusted && !readOnly && !closing;
  const refresh = async () => {
    const current = statusScope.current.advance();
    let result: Capability;
    try { result = await rpc("terminal.status") as Capability; }
    catch (cause) { if (!mounted.current || !current()) return; throw cause; }
    if (!mounted.current || !current()) return;
    setCapability(result);
    setActive(value => result.terminals.some(item => item.id === value) ? value : result.terminals.find(item => item.id)?.id || "");
  };
  useEffect(() => {
    mounted.current = true;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!locked.current && !closeLock.current) await refresh(); } catch (cause) { if (!stopped) setError(cause instanceof Error ? cause.message : String(cause)); }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      stopped = true; mounted.current = false; clearTimeout(timer);
      statusScope.current.advance();
      const pending = pendingRequest.current;
      if (pending) void rpc("terminal.cancel", { request_id: pending }).catch(() => undefined);
    };
  }, [sessionId, rpc]);
  useEffect(() => {
    if (!active || !surface.current || !terminalRendererAvailable) return;
    const theme = getComputedStyle(surface.current);
    const view = createTerminalEmulator(surface.current, { foreground: theme.color, background: theme.backgroundColor });
    emulator.current = view;
    if (view) view.write(transcripts.current.get(active) || "");
    const observer = new ResizeObserver(() => view?.fit());
    observer.observe(surface.current);
    return () => { observer.disconnect(); view?.dispose(); emulator.current = null; };
  }, [active]);
  useEffect(() => {
    if (!active || !capability?.trusted || !terminalOutputPending(selected, cursors.current.get(active) || 0)) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const since = cursors.current.get(active) || 0;
        const result = await rpc("terminal.read", { terminal_id: active, since }) as TerminalState;
        if (stopped || !mounted.current || currentActive.current !== active) return;
        if (typeof result.output === "string" && typeof result.cursor === "number" && result.cursor >= since) {
          if (result.truncated) setStreamNotice(t("早期终端输出已截断；当前显示不代表完整历史。"));
          const retained = (transcripts.current.get(active) || "") + result.output;
          transcripts.current.set(active, retained.slice(-262144));
          cursors.current.set(active, result.cursor);
          emulator.current?.write(result.output);
        }
        setCapability(current => current ? { ...current, terminals: current.terminals.map(item => item.id === active ? { ...item, ...result } : item) } : current);
        if (!terminalOutputPending(result, cursors.current.get(active) || 0)) return;
      } catch (cause) {
        if (!stopped && mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
        // A failed stream does not replay input. Stop polling until the user
        // explicitly inspects state; backend UNKNOWN also prevents commands.
        return;
      }
      if (!stopped) timer = setTimeout(read, 500);
    };
    void read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, capability?.trusted, running, selected?.has_more, selected?.end, selected?.uncertain, rpc]);

  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    if (locked.current || closeLock.current) return;
    if (action === "input" && new TextEncoder().encode(String(extra.text || "")).length > 16384) { setError(t("一次终端输入最多 16 KiB")); return; }
    locked.current = true; setBusy(true); setError("");
    statusScope.current.advance();
    const requestId = crypto.randomUUID(); pendingRequest.current = requestId;
    try {
      const result = await rpc(action === "close" ? "terminal.stop" : "terminal.execute",
        action === "close" ? { terminal_id: active } : { action, terminal_id: active || undefined, request_id: requestId, ...extra }) as TerminalState;
      if (!mounted.current) return;
      if (result.terminal_id) setActive(result.terminal_id);
      if (action === "input") setText("");
      if (result.status === "unknown" || result.uncertain) setError(t("终端结果未确认；不会重发输入。请核对状态并尝试关闭。"));
      await refresh();
    } catch (cause) { if (mounted.current) { setError(cause instanceof Error ? cause.message : String(cause)); await refresh().catch(() => undefined); } }
    finally { pendingRequest.current = null; locked.current = false; if (mounted.current) setBusy(false); }
  };
  const closeTerminal = async () => {
    if (closeLock.current || !active) return;
    closeLock.current = true; setClosing(true);
    statusScope.current.advance();
    try { await rpc("terminal.stop", { terminal_id: active }); if (mounted.current) await refresh(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { closeLock.current = false; if (mounted.current) setClosing(false); }
  };

  return <section className="terminal-panel" aria-label={t("会话终端")} aria-busy={busy}>
    <p className="terminal-capability" role="status">{capability ? `${capability.sandbox || "—"} · ${capability.runtime?.["python-version"] || t("运行时未就绪")}` : t("正在核对终端能力…")}</p>
    {!terminalRendererAvailable && <p>{t("此 Web 构建未包含终端模拟器；请使用具备完整依赖的桌面包。")}</p>}
    {capability?.reason && <p>{capability.reason}</p>}
    {capability?.cleanup?.mode === "native-process-group" && <p role="note">{t("原生终端按登记的进程组清理；脱离进程组或会话的后代可能残留，清理确认不代表所有后代都已退出。")}</p>}
    {capability && !capability.trusted && <p>{t("项目处于受限状态；查看项目信任范围后再决定，运行中的终端会请求关闭。")}</p>}
    <div className="terminal-toolbar">
      <select aria-label={t("终端会话")} value={active} disabled={busy || closing} onChange={event => { setActive(event.target.value); setError(""); setStreamNotice(""); }}>
        <option value="">{t("选择终端")}</option>{capability?.terminals.map(item => <option key={item.id} value={item.id}>{item.id?.slice(0, 8)} · {item.status}</option>)}
      </select>
      <button type="button" disabled={busy || closing || !canOperate || capability?.terminals.some(item => item.status === "unknown")}
        onClick={() => void run("open", { cols: 90, rows: 24 })}><Icon name="plus" />{t("新建终端")}</button>
      <button type="button" disabled={!active || closing} onClick={() => void closeTerminal()}>{t(closing ? "正在关闭…" : "关闭终端")}</button>
      <button type="button" disabled={busy || closing} onClick={() => void refresh().catch(cause => setError(String(cause)))}>{t("核对状态")}</button>
      {busy && <button type="button" onClick={() => { const id = pendingRequest.current; if (id) void rpc("terminal.cancel", { request_id: id }).catch(cause => setError(String(cause))); }}>{t("取消操作")}</button>}
    </div>
    {error && <p className="terminal-error" role="alert">{error}</p>}
    {streamNotice && <p role="status">{streamNotice}</p>}
    <div className="terminal-surface" ref={surface} aria-label={t("终端输出")} />
    <p className="terminal-input-help">{t("输入先编辑再明确发送，并沿用会话审批。关闭面板保留终端；切换会话不会把输入发送到另一终端。15 分钟无输入或 1 小时上限会请求关闭。")}</p>
    <textarea aria-label={t("终端输入")} value={text} onChange={event => setText(event.target.value)} maxLength={16384} rows={3}
      placeholder={t("输入命令或终端文本；发送一行会追加换行")} disabled={busy || !running || !canOperate} autoComplete="off" spellCheck={false} />
    <div className="terminal-toolbar">
      <button type="button" disabled={!text || busy || !running || !canOperate} onClick={() => void run("input", { text: `${text}\n` })}>{t("发送一行")}</button>
      <button type="button" disabled={!text || busy || !running || !canOperate} onClick={() => void run("input", { text })}>{t("发送原文")}</button>
      <button type="button" disabled={busy || !running || !canOperate} onClick={() => void run("interrupt")}>{t("中断")}</button>
      <button type="button" disabled={busy || !running || !canOperate} onClick={() => void run("resize", emulator.current?.dimensions() || { cols: 90, rows: 24 })}>{t("同步尺寸")}</button>
    </div>
  </section>;
}
