import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChangeSet, FileListing, FilePreview } from "../../web-host/workspace-files.js";

export interface WorkspacePanelApi {
  list: (workspaceId: string, path: string, signal: AbortSignal) => Promise<FileListing>;
  search: (workspaceId: string, query: string, signal: AbortSignal) => Promise<FileListing>;
  preview: (workspaceId: string, path: string, signal: AbortSignal) => Promise<FilePreview>;
  contentUrl: (workspaceId: string, path: string, download?: boolean) => string;
  changes?: (workspaceId: string, sessionId: string, signal: AbortSignal) => Promise<ChangeSet | null>;
}
export interface WorkspacePanelProps {
  workspaceId: string; sessionId?: string; api: WorkspacePanelApi;
  onReference?: (text: string) => void; onClose?: () => void;
  responseDetail?: "short" | "auto" | "detailed";
  onResponseDetail?: (value: "short" | "auto" | "detailed") => Promise<void>;
}

export function sandboxedHtml(text: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">${text}`;
}

export function WorkspaceVerificationSummary({ changes }: { changes: ChangeSet }) {
  const passed = !changes.partial && changes.verification?.status === "PASS" && !!changes.verification.checks?.length && changes.verification.checks.every(check => check.status === "PASS");
  const status = passed ? "PASS" : changes.verification?.status === "PASS" ? "UNKNOWN" : changes.verification?.status || "NOT_RUN";
  const labels = { NOT_RUN: "尚未关联本轮文件指纹的独立验收记录", VERIFYING: "正在独立验收，结果尚未确定",
    PASS: `独立验收通过 · ${changes.verification?.checks?.length || 0} 项检查`, FAIL: "独立验收未通过，请查看失败检查",
    STALE: "验收已过期，源码已变化", UNKNOWN: "验收结果未确认，文件或验收材料需要核对" };
  const execution = changes.execution && { completed: "执行已完成", failed: "执行失败", cancelled: "执行已取消", uncertain: "执行结果未确认" }[changes.execution.status];
  return <div className="workspace-result-summary" aria-label="本轮结果摘要" role="status" aria-live="polite" aria-atomic="true">
          <p><strong>变更</strong> · {changes.files.length} 个文本文件{changes.partial ? " · 部分记录" : " · 限定范围内的快照"}{execution ? ` · ${execution}` : ""}</p>
          <p><strong>验收</strong> · {labels[status]}</p>
          <p><strong>下一步</strong> · {passed ? "审查已验证快照；合入与发布仍需明确授权" : status === "VERIFYING" ? "等待独立验收完成，可继续阅读差异" : status === "FAIL" ? "查看失败检查，修复后再验收" : status === "STALE" ? "核对新差异，建立新候选再验收" : changes.partial ? "核对遗漏与差异，再运行验收" : "核对差异并运行验收"}</p>
          {!!changes.verification?.checks?.length && <details open={status === "FAIL" || status === "UNKNOWN"}>
            <summary>检查详情 · {changes.verification.checks.length} 项</summary>
            <ul>{changes.verification.checks.map(check => <li key={check.id}>{check.id} · {check.status}
              {check.detailsUrl && /^\/api\/candidates\/coding-[a-f0-9]{32}\/checks\/[A-Za-z0-9_-]{1,100}$/.test(check.detailsUrl)
                && <> · <a href={check.detailsUrl} target="_blank" rel="noreferrer noopener">查看检查记录</a></>}</li>)}</ul>
          </details>}
  </div>;

}

/** File access is server-authorized; changing workspace aborts and discards all prior reads. */
export function WorkspacePanel({ workspaceId, sessionId, api, onReference, onClose, responseDetail = "auto", onResponseDetail }: WorkspacePanelProps) {
  const [path, setPath] = useState(""), [query, setQuery] = useState(""), [listing, setListing] = useState<FileListing | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null), [changes, setChanges] = useState<ChangeSet | null>(null);
  const [tab, setTab] = useState<"files" | "changes">("files"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState(0), read = useRef<AbortController | null>(null), view = useRef<AbortController | null>(null);
  const [savingDetail, setSavingDetail] = useState(false), [detailError, setDetailError] = useState("");
  const detailScope = useRef(0);
  useEffect(() => { detailScope.current++; setSavingDetail(false); setDetailError(""); return () => { detailScope.current++; }; }, [workspaceId, sessionId]);
  const saveDetail = async (value: "short" | "auto" | "detailed") => {
    if (!onResponseDetail || savingDetail) return;
    const scope = detailScope.current; setSavingDetail(true); setDetailError("");
    try { await onResponseDetail(value); }
    catch (failure) { if (scope === detailScope.current) setDetailError(failure instanceof Error ? failure.message : "保存失败，请重新选择。"); }
    finally { if (scope === detailScope.current) setSavingDetail(false); }
  };
  useEffect(() => { setPath(""); setQuery(""); setPreview(null); setChanges(null); setListing(null); view.current?.abort(); }, [workspaceId]);
  useEffect(() => {
    const controller = new AbortController(); read.current?.abort(); read.current = controller;
    setBusy(true); setError(""); setListing(null); setChanges(null);
    const timer = setTimeout(() => {
      const work = tab === "changes" ? api.changes && sessionId ? api.changes(workspaceId, sessionId, controller.signal).then(value => { if (!controller.signal.aborted) setChanges(value); }) : Promise.resolve()
        : (query.trim() ? api.search(workspaceId, query.trim(), controller.signal) : api.list(workspaceId, path, controller.signal)).then(value => { if (!controller.signal.aborted) setListing(value); });
      void work.catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败，请重试。"); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, query ? 180 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [workspaceId, sessionId, path, query, tab, revision, api]);
  useEffect(() => () => view.current?.abort(), []);
  useEffect(() => {
    if (tab !== "changes" || changes?.verification?.status !== "VERIFYING") return;
    const timer = setTimeout(() => setRevision(value => value + 1), 1000);
    return () => clearTimeout(timer);
  }, [tab, changes]);
  const openFile = async (file: string) => {
    view.current?.abort(); const controller = new AbortController(); view.current = controller;
    setBusy(true); setError(""); setPreview(null);
    try { const value = await api.preview(workspaceId, file, controller.signal); if (!controller.signal.aborted) setPreview(value); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "预览失败，请重试。"); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  };
  return <aside className="workspace-panel" aria-label="工作区文件">
    <header><strong>工作区文件</strong>{onClose && <button type="button" aria-label="关闭文件面板" onClick={onClose}>×</button>}</header>
    <nav className="workspace-tabs" aria-label="文件视图"><button type="button" aria-pressed={tab === "files"} onClick={() => setTab("files")}>文件</button>
      <button type="button" aria-pressed={tab === "changes"} onClick={() => { setTab("changes"); setPreview(null); }}>本轮变更</button>
      <button type="button" onClick={() => setRevision(value => value + 1)} disabled={busy}>刷新</button></nav>
    {onResponseDetail && sessionId && <div className="workspace-detail-preference" aria-busy={savingDetail}>
      <label>结果详略<select aria-label="结果详略" value={responseDetail} disabled={savingDetail}
        onChange={event => void saveDetail(event.target.value as "short" | "auto" | "detailed")}>
        <option value="short">简洁</option><option value="auto">自动</option><option value="detailed">详细</option>
      </select></label>
      <p className="workspace-detail-help" role={detailError ? "alert" : "status"}>{detailError
        ? `${detailError} 请核对当前设置后重新选择。` : savingDetail ? "正在保存…" : "下一模型请求前生效；文件详情随偏好展开。"}</p>
    </div>}
    {tab === "files" && <><input className="workspace-search" type="search" value={query} aria-label="搜索文件路径" placeholder="搜索文件路径…"
      onChange={event => { setQuery(event.target.value); setPreview(null); }} />
      <div className="workspace-breadcrumb"><button type="button" disabled={!path && !query} onClick={() => { setPath(path.split("/").slice(0, -1).join("/")); setQuery(""); setPreview(null); }}>上一级</button><span>{query ? "搜索结果" : path || "工作区根目录"}</span></div></>}
    {busy && <div role="status" className="workspace-feedback"><span>正在读取…</span><button type="button" onClick={() => { read.current?.abort(); view.current?.abort(); setBusy(false); }}>取消</button></div>}
    {error && <div role="alert" className="workspace-error">{error}<button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    <div className="workspace-body">
      {tab === "files" && !preview && listing && <>{listing.entries.length === 0 ? <p className="workspace-muted">没有可显示的文件。隐藏、敏感或构建目录不会列出。</p> : <ul className="workspace-file-list">{listing.entries.map(entry => <li key={entry.path}>
        <button type="button" onClick={() => entry.kind === "directory" ? (setQuery(""), setPath(entry.path)) : void openFile(entry.path)}><span aria-hidden="true">{entry.kind === "directory" ? "▸" : "▤"}</span><span>{query ? entry.path : entry.name}</span></button>
        {onReference && entry.kind === "file" && <button type="button" className="workspace-reference" aria-label={`引用 ${entry.path}`} onClick={() => onReference(`@file:${JSON.stringify(entry.path)}`)}>引用</button>}
      </li>)}</ul>}{listing.truncated && <p className="workspace-muted">结果已达显示上限，请进入子目录或缩小搜索范围。</p>}</>}
      {tab === "files" && preview && <section className="workspace-preview" aria-label="文件预览">
        <div className="workspace-preview-title"><button type="button" onClick={() => setPreview(null)}>返回文件</button><strong>{preview.name}</strong>
          {preview.size <= 8 * 1024 * 1024 && <a href={api.contentUrl(workspaceId, preview.path, true)} download>下载</a>}</div>
        <p className="workspace-muted">{preview.path} · {Math.ceil(preview.size / 1024)} KiB</p>
        {preview.notice && <p className="workspace-muted">{preview.notice}</p>}
        {preview.kind === "text" && (preview.mime === "text/markdown" ? <><div className="workspace-markdown"><Markdown remarkPlugins={[remarkGfm]}
          components={{ img: ({ alt }) => <span>[图片：{alt || "未加载"}]</span>, a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}>{preview.text || ""}</Markdown></div>
          <details><summary>Markdown 源文</summary><pre tabIndex={0}>{preview.text}</pre></details></> : <pre tabIndex={0}>{preview.text}</pre>)}
        {preview.kind === "html" && <><p className="workspace-muted">静态 HTML 预览：脚本、网络和表单已禁用。</p><iframe title={`${preview.name} 静态预览`} sandbox="" referrerPolicy="no-referrer" srcDoc={sandboxedHtml(preview.text || "")} /></>}
        {preview.kind === "image" && <img src={api.contentUrl(workspaceId, preview.path)} alt={preview.name} />}
        {preview.kind === "pdf" && <><iframe title={`${preview.name} PDF 预览`} src={api.contentUrl(workspaceId, preview.path)} referrerPolicy="no-referrer" /><p className="workspace-muted">若浏览器无法显示 PDF，可下载后打开。</p></>}
      </section>}
      {tab === "changes" && !busy && !changes && <p className="workspace-muted">本会话暂无已完成回合的文件快照。</p>}
      {tab === "changes" && changes && <>
        <WorkspaceVerificationSummary changes={changes} />
        <details className="workspace-capture-scope" open={changes.partial || responseDetail === "detailed"}>
          <summary>快照范围{changes.partial ? " · 需要核对" : "与限制"}</summary><p className="workspace-muted">{changes.notice}</p>
        </details>
        {changes.files.length === 0 ? <p className="workspace-muted">记录范围内没有文本改动。</p> : changes.files.map((file, index) => <details className="workspace-diff" key={`${changes.turnId}:${file.path}:${responseDetail}`} open={responseDetail === "detailed" || (responseDetail === "auto" && changes.partial && index === 0)}><summary>{file.status === "added" ? "新增" : file.status === "deleted" ? "删除" : "修改"} · {file.path}</summary><pre tabIndex={0}>{file.diff}</pre></details>)}</>}
    </div>
  </aside>;
}
