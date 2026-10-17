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
}

export function sandboxedHtml(text: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">${text}`;
}

/** File access is server-authorized; changing workspace aborts and discards all prior reads. */
export function WorkspacePanel({ workspaceId, sessionId, api, onReference, onClose }: WorkspacePanelProps) {
  const [path, setPath] = useState(""), [query, setQuery] = useState(""), [listing, setListing] = useState<FileListing | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null), [changes, setChanges] = useState<ChangeSet | null>(null);
  const [tab, setTab] = useState<"files" | "changes">("files"), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState(0), read = useRef<AbortController | null>(null), view = useRef<AbortController | null>(null);
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
      {tab === "changes" && changes && <><p className="workspace-muted">{changes.partial ? "部分文件已对比。 " : ""}{changes.notice}</p>
        {changes.files.length === 0 ? <p className="workspace-muted">记录范围内没有文本改动。</p> : changes.files.map(file => <details className="workspace-diff" key={file.path}><summary>{file.status === "added" ? "新增" : file.status === "deleted" ? "删除" : "修改"} · {file.path}</summary><pre tabIndex={0}>{file.diff}</pre></details>)}</>}
    </div>
  </aside>;
}
