import { useEffect, useRef, useState } from "react";
import { RequestScope } from "./request-scope";
import { officeCancellationEvent, officeResult } from "./office-result";
import { uiText as t } from "./i18n";

export type OfficeRpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type Capability = { available: boolean; trusted?: boolean; runtime?: { reason?: string } };

/** Conversion is an explicit approved write. Normal file inspection stays read-only. */
export function OfficePreviewAction({ path, rpc, readOnly, onCreated }: {
  path: string; rpc: OfficeRpc; readOnly: boolean; onCreated: (path: string, bytes: number) => Promise<void>;
}) {
  const [output, setOutput] = useState(() => `${path}.preview-${crypto.randomUUID().slice(0, 8)}.pdf`);
  const [capability, setCapability] = useState<Capability | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const scope = useRef(new RequestScope()), statusScope = useRef(new RequestScope());
  const pending = useRef<string | null>(null), lock = useRef(false), cancelLock = useRef<string | null>(null);
  const cancellationRequested = useRef(false);
  const refresh = async () => {
    const current = scope.current.capture(), latest = statusScope.current.advance();
    try { const value = await rpc("workspace.runtime-status"); if (current() && latest()) setCapability(value as Capability); }
    catch { if (current() && latest()) setCapability({ available: false,
      runtime: { reason: t("无法核实此会话的 Office 转换能力；可重新核对，或下载原文件。") } }); }
  };
  useEffect(() => {
    scope.current.advance(); void refresh();
    const cancelIntent = (event: Event) => {
      const id = (event as CustomEvent).detail?.request_id;
      if (typeof id === "string" && pending.current === id) cancellationRequested.current = true;
    };
    window.addEventListener(officeCancellationEvent, cancelIntent);
    return () => {
      scope.current.advance();
      statusScope.current.advance();
      window.removeEventListener(officeCancellationEvent, cancelIntent);
      if (pending.current) void rpc("workspace.office-cancel", { request_id: pending.current }).catch(() => undefined);
    };
  }, [rpc, path]);
  const convert = async () => {
    if (lock.current || !output.trim() || readOnly || !capability?.available || !capability.trusted) return;
    lock.current = true; setBusy(true); setMessage("");
    cancellationRequested.current = false;
    const current = scope.current.advance(), id = crypto.randomUUID(), chosen = output;
    pending.current = id;
    try {
      const result = officeResult(await rpc("workspace.office-preview", { path, output: chosen, request_id: id }));
      pending.current = null;
      if (current()) {
        if (cancellationRequested.current) { setMessage(t("转换已完成，取消未回滚副本：{0}。请手动核对文件。", result.output)); return; }
        setMessage(result.previewable ? t("PDF 副本已生成：{0}", result.output)
          : t("PDF 副本已生成：{0}；超过 8 MiB 内嵌预览上限，仅显示文件信息。", result.output));
        await onCreated(result.output, result.bytes);
      }
    } catch (error) {
      if (current()) setMessage(t("{0} 请先核对输出 {1}，不会自动重做。", error instanceof Error ? error.message : String(error), chosen));
    } finally {
      pending.current = null; lock.current = false; if (current()) setBusy(false);
    }
  };
  const cancel = async () => {
    const id = pending.current, current = scope.current.capture();
    if (!id || cancelLock.current === id) return;
    cancelLock.current = id;
    cancellationRequested.current = true;
    try {
      const result = await rpc("workspace.office-cancel", { request_id: id }) as { cancelled?: boolean };
      if (current()) setMessage(result.cancelled === true ? t("取消已登记；请核对副本是否已经生成。") : t("取消未登记，请核对原操作结果。"));
    }
    catch (error) { if (current()) setMessage(error instanceof Error ? error.message : String(error)); }
    finally { if (cancelLock.current === id) cancelLock.current = null; }
  };
  return <div className="workspace-office-action" aria-busy={busy}>
    <p className="workspace-muted">{t("生成新的 PDF 副本后在此预览。原文件不变，已有目标不会覆盖；操作需要项目可信与会话审批。")}</p>
    {!capability && <p role="status">{t("正在核对转换能力…")}</p>}
    {capability && !capability.available && <p role="status">{capability.runtime?.reason || t("此运行环境未提供完整 Office 运行时。")}</p>}
    {capability?.trusted === false && <p className="workspace-muted">{t("项目仍处于受限状态；请先查看项目信任范围。")}</p>}
    <label>{t("新 PDF 路径")}<input value={output} onChange={event => setOutput(event.target.value)}
      disabled={busy} maxLength={2048} autoComplete="off" spellCheck={false} /></label>
    <button type="button" disabled={busy || readOnly || !capability?.available || !capability.trusted || !output.trim()}
      onClick={() => void convert()}>{t(busy ? "正在转换…" : "生成 PDF 并预览")}</button>
    <button type="button" disabled={busy} onClick={() => void refresh()}>{t("核对转换能力")}</button>
    {busy && <button type="button" onClick={() => void cancel()}>{t("取消转换")}</button>}
    {message && <p role="status" className="workspace-muted">{message}</p>}
  </div>;
}
