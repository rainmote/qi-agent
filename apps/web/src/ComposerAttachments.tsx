import { uiText as t } from "./i18n";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AttachmentRef } from "../../web-host/workspace-files.js";

export type { AttachmentRef } from "../../web-host/workspace-files.js";
export interface AttachmentUpload { name: string; mime: string; base64: string }
export type ReferenceSuggestions = { files: Array<{ path: string }>; sessions: Array<{ id: string; name: string | null }> };
export function referenceQuery(value: string): { kind?: string; query: string; start: number } | null {
  const found = /(?:^|\s)@(file|session)?(?::([^\n"]*))?$/.exec(value);
  return found ? { kind: found[1], query: found[2] || "", start: found.index + (found[0].startsWith("@") ? 0 : 1) } : null;
}

export function ComposerReferences({ workspaceId, value, onChange, suggest, disabled }: {
  workspaceId: string; value: string; onChange: (value: string) => void; disabled?: boolean;
  suggest: (workspaceId: string, query: string, signal: AbortSignal) => Promise<ReferenceSuggestions>;
}) {
  const query = referenceQuery(value), [found, setFound] = useState<ReferenceSuggestions | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setFound(null); setError(""); if (!query || disabled) { setBusy(false); return; }
    const controller = new AbortController(); setBusy(true);
    const timer = setTimeout(() => { void suggest(workspaceId, query.query, controller.signal)
      .then(result => { if (!controller.signal.aborted) setFound(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("无法读取引用")); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); }); }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [workspaceId, query?.query, query?.kind, !!query, suggest, disabled]);
  if (!query || disabled) return null;
  const choose = (kind: "file" | "session", path: string) => onChange(`${value.slice(0, query.start)}@${kind}:${JSON.stringify(path)} `);
  return <section className="composer-references" aria-label={t("文件和会话引用")}>
    <strong>{t("引用当前工作区")}</strong><button type="button" onClick={() => onChange(value.slice(0, query.start))}>{t("取消")}</button>
    {busy && <p role="status">{t("正在查找…")}</p>}{error && <p role="alert">{error}</p>}
    {found && <ul>{query.kind !== "session" && found.files.map(file => <li key={`file-${file.path}`}><button type="button" onClick={() => choose("file", file.path)}>{t("文件 ·") + " "}{file.path}</button></li>)}
      {query.kind !== "file" && found.sessions.map(session => <li key={`session-${session.id}`}><button type="button" onClick={() => choose("session", session.id)}>{t("会话 ·") + " "}{session.name || session.id}</button></li>)}</ul>}
    {found && !found.files.length && !found.sessions.length && <p>{t("没有匹配的引用。")}</p>}
  </section>;
}
export interface ComposerAttachmentsProps {
  workspaceId: string;
  items: AttachmentRef[];
  onChange: (items: AttachmentRef[]) => void;
  upload: (workspaceId: string, input: AttachmentUpload, signal: AbortSignal) => Promise<AttachmentRef>;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  children?: ReactNode;
}

export function encodeAttachment(file: File, signal: AbortSignal): Promise<AttachmentUpload> {
  if (file.size < 1 || file.size > 8 * 1024 * 1024) return Promise.reject(new Error(t("每个附件须为 1 字节至 8 MiB。")));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const abort = () => { reader.abort(); reject(new DOMException(t("已取消"), "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", abort);
    reader.onerror = () => { cleanup(); reject(new Error(t("无法读取文件，请重新选择。"))); };
    reader.onload = () => {
      cleanup();
      if (signal.aborted) { reject(new DOMException(t("已取消"), "AbortError")); return; }
      resolve({ name: file.name, mime: file.type || "application/octet-stream", base64: String(reader.result).split(",", 2)[1] || "" });
    };
    if (signal.aborted) abort(); else reader.readAsDataURL(file);
  });
}

/** Uploads stay separate from the prompt; only durable references enter its controlled value. */
export function ComposerAttachments({ workspaceId, items, onChange, upload, disabled = false, onBusyChange, inputRef, children }: ComposerAttachmentsProps) {
  const localInput = useRef<HTMLInputElement>(null), active = useRef<AbortController | null>(null);
  const input = inputRef || localInput;
  const current = useRef({ workspaceId, items, onChange, onBusyChange });
  current.current = { workspaceId, items, onChange, onBusyChange };
  const [pending, setPending] = useState<string | null>(null), [error, setError] = useState("");
  useEffect(() => {
    active.current?.abort(); active.current = null; setPending(null); setError("");
    current.current.onBusyChange?.(false);
    return () => { active.current?.abort(); current.current.onBusyChange?.(false); };
  }, [workspaceId]);
  const add = async (files: File[]) => {
    if (disabled || active.current || !workspaceId || !files.length) return;
    if (files.length + items.length > 8) { setError(t("每条消息最多 8 个附件，请减少选择。 ")); return; }
    const controller = new AbortController(); active.current = controller; onBusyChange?.(true); setError("");
    try {
      for (const file of files) {
        setPending(file.name);
        const encoded = await encodeAttachment(file, controller.signal);
        const result = await upload(workspaceId, encoded, controller.signal);
        if (controller.signal.aborted || current.current.workspaceId !== workspaceId) return;
        const next = [...current.current.items, result]; current.current.items = next; current.current.onChange(next);
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("上传失败，请重新选择文件重试。"));
    } finally {
      if (active.current === controller) { active.current = null; setPending(null); current.current.onBusyChange?.(false); }
      if (input.current) input.current.value = "";
    }
  };
  return <div className="composer-attachments" onDragOver={event => { if (!disabled) event.preventDefault(); }}
    onDrop={event => { event.preventDefault(); void add(Array.from(event.dataTransfer.files)); }}>
    <input ref={input} type="file" multiple hidden aria-label={t("选择附件")} disabled={disabled || !!pending}
      onChange={event => void add(Array.from(event.target.files || []))} />
    {!children && <div className="attachment-actions">
      <button type="button" className="button ghost" onClick={() => input.current?.click()} disabled={disabled || !!pending || items.length >= 8}>{t("添加附件")}</button>
      <span className="workspace-muted">{t("可拖入图片或文件 · 每个 ≤8 MiB")}</span>
    </div>}
    {items.length > 0 && <ul className="attachment-list" aria-label={t("待发送附件")}>{items.map(item => <li key={item.id}>
      <span title={item.name}>{item.name}</span><small>{Math.ceil(item.size / 1024)} KiB</small>
      <button type="button" aria-label={t("移除 {0}", item.name)} disabled={disabled || !!pending}
        onClick={() => onChange(items.filter(entry => entry.id !== item.id))}>×</button>
    </li>)}</ul>}
    {pending && <div className="workspace-feedback" role="status"><span>{t("正在上传") + " "}{pending}</span>
      <button type="button" onClick={() => active.current?.abort()}>{t("取消上传")}</button></div>}
    {error && <p className="workspace-error" role="alert">{error}</p>}
    {children}
  </div>;
}
