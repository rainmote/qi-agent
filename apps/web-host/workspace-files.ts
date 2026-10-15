import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readWorkspaceVerification, type VerificationConfig, type WorkspaceVerification } from "../shared/workspace-verification.mjs";
import type { WorkspaceRegistry } from "./workspaces.js";
import { ensurePrivateDirectory, writePrivateFileAtomically } from "./storage.js";

const exec = promisify(execFile);
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 256 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 200;
const EXCLUDED = new Set(["node_modules", "target", "dist", "build", "vendor", "coverage", "__pycache__"]);
const SECRET = /(?:^|[._-])(?:secrets?|credentials?|tokens?|auth|passwords?)(?:[._-]|$)|\.(?:pem|key|p12|pfx|keystore)$/i;
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".html": "text/html", ".htm": "text/html", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".txt": "text/plain" };
const TEXT = new Set([".txt", ".md", ".json", ".csv", ".tsv", ".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx", ".clj", ".cljs", ".edn", ".rs", ".py", ".sh", ".yml", ".yaml", ".toml", ".xml", ".svg", ".sql", ".java", ".c", ".h", ".cpp", ".go", ".rb"]);
export interface AttachmentRef { type: "attachment"; id: string; name: string; mime: string; size: number; workspaceId: string }
export interface FileEntry { name: string; path: string; kind: "directory" | "file"; size?: number }
export interface FileListing { path: string; entries: FileEntry[]; truncated: boolean }
export interface FilePreview { path: string; name: string; mime: string; size: number; kind: "text" | "image" | "pdf" | "html" | "unsupported"; text?: string; notice?: string }
export interface FileChange { path: string; status: "added" | "modified" | "deleted"; before: string; after: string; diff: string }
export interface TurnExecution { status: "completed" | "failed" | "cancelled" | "uncertain"; reason?: string }
export interface ChangeSet { turnId: string; files: FileChange[]; partial: boolean; notice?: string; verification?: WorkspaceVerification; execution?: TurnExecution }
interface Snapshot { workspaceId: string; sessionId?: string; files: Record<string, string>; partial: boolean }
export interface ServedFile { body: Buffer; headers: Record<string, string> }

function allowedPath(path: string): boolean {
  return path.split(/[\\/]/).every(part => part && part !== ".." && !part.startsWith(".") && !EXCLUDED.has(part) && !SECRET.test(part));
}
function validId(id: string): void { if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new Error("Invalid resource identifier"); }
function mimeFor(name: string): string { return MIME[extname(name).toLowerCase()] || (TEXT.has(extname(name).toLowerCase()) ? "text/plain" : "application/octet-stream"); }
function textual(name: string, data: Buffer): boolean { return (TEXT.has(extname(name).toLowerCase()) || !extname(name)) && !data.includes(0); }
function safeName(name: string): string {
  if (typeof name !== "string" || name.length > 180 || !name.trim() || basename(name) !== name || /[\\/\x00-\x1f\x7f]/.test(name)) throw new Error("Invalid attachment name");
  return name;
}
function headers(name: string, mime: string, download: boolean): Record<string, string> {
  return { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}` };
}
function diff(path: string, before: string, after: string): string {
  const old = before.split("\n"), next = after.split("\n");
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
  const removed = old.slice(prefix, old.length - suffix), added = next.slice(prefix, next.length - suffix);
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${prefix + 1},${removed.length} +${prefix + 1},${added.length} @@`, ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join("\n");
}

/** Read-only workspace access and separately stored uploads. Every call rechecks its workspace lease. */
export class WorkspaceFiles {
  readonly attachmentDirectory: string;
  readonly snapshotDirectory: string;
  private readonly verification: VerificationConfig | undefined;
  private candidateReader?: (workspaceId: string, changes: ChangeSet) => Promise<WorkspaceVerification | undefined>;
  useCandidateVerification(reader: (workspaceId: string, changes: ChangeSet) => Promise<WorkspaceVerification | undefined>): void { this.candidateReader = reader; }
  constructor(private readonly workspaces: WorkspaceRegistry, options: { attachmentDirectory?: string; snapshotDirectory?: string; verification?: VerificationConfig } = {}) {
    this.verification = options.verification;
    if (this.verification && (!isAbsolute(this.verification.directory) || !/^[a-f0-9]{40}$/.test(this.verification.controllerSha))) throw new Error("Pin an absolute verifier directory and trusted controller SHA");
    this.attachmentDirectory = options.attachmentDirectory || process.env.QI_AGENT_ATTACHMENT_DIR || join(process.env.QI_AGENT_HOME || join(homedir(), ".qi-agent"), "attachments");
    this.snapshotDirectory = options.snapshotDirectory || join(workspaces.stateDirectory, "snapshots");
  }

  private async path(workspaceId: string, path: string, rootAllowed = false): Promise<{ absolute: string; check: () => void }> {
    const workspace = this.workspaces.get(workspaceId), check = this.workspaces.lease(workspaceId);
    if (typeof path !== "string" || path.length > 2048 || isAbsolute(path) || path.includes("\\") || (path !== "" && !allowedPath(path)) || (!rootAllowed && path === "")) throw new Error("File path is outside the permitted workspace");
    const root = await realpath(workspace.path);
    if (root !== workspace.path || (await lstat(workspace.path)).isSymbolicLink()) throw new Error("Workspace root changed; add it again to grant access");
    let cursor = root;
    for (const segment of path.split("/").filter(Boolean)) {
      cursor = join(cursor, segment);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symbolic links are not available in the file panel");
    }
    const absolute = await realpath(cursor), rel = relative(root, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("File path escaped the workspace");
    check(); return { absolute, check };
  }

  private async bytes(workspaceId: string, path: string, maxBytes: number): Promise<Buffer> {
    const target = await this.path(workspaceId, path);
    const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error(`File exceeds the ${Math.floor(maxBytes / 1024)} KiB read limit`);
      // Read through the validated descriptor, bound growth, then verify its path still names that inode.
      const data = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      const current = await this.path(workspaceId, path);
      const now = await lstat(current.absolute);
      if (now.ino !== info.ino || now.dev !== info.dev || now.size !== info.size || bytesRead > maxBytes) throw new Error("File changed while reading; retry");
      target.check(); return data.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }

  async list(workspaceId: string, path = ""): Promise<FileListing> {
    const target = await this.path(workspaceId, path, true);
    const found = await readdir(target.absolute, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const entry of found) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      if (!allowedPath(child) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      entries.push({ name: entry.name, path: child, kind: entry.isDirectory() ? "directory" : "file" });
    }
    target.check();
    entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
    return { path, entries: entries.slice(0, 500), truncated: entries.length > 500 };
  }

  async search(workspaceId: string, query: string, signal?: AbortSignal): Promise<FileListing> {
    if (typeof query !== "string" || query.length > 200) throw new Error("Search query is too long");
    const entries: FileEntry[] = [], queue = [""]; let visited = 0, truncated = false;
    while (queue.length && visited < MAX_ENTRIES) {
      signal?.throwIfAborted();
      const level = await this.list(workspaceId, queue.shift()!); truncated ||= level.truncated;
      for (const entry of level.entries) {
        visited++;
        if (entry.path.toLocaleLowerCase().includes(query.toLocaleLowerCase())) entries.push(entry);
        if (entry.kind === "directory") queue.push(entry.path);
        if (entries.length >= 100 || visited >= MAX_ENTRIES) { truncated = true; break; }
      }
      if (entries.length >= 100) break;
    }
    return { path: "", entries, truncated: truncated || queue.length > 0 };
  }

  async preview(workspaceId: string, path: string): Promise<FilePreview> {
    const target = await this.path(workspaceId, path), info = await lstat(target.absolute), name = basename(path), mime = mimeFor(name);
    if (!info.isFile()) throw new Error("Select a file to preview");
    const result: FilePreview = { path, name, mime, size: info.size, kind: "unsupported" };
    if (info.size > MAX_ATTACHMENT_BYTES) result.notice = "文件超过 8 MiB，仅显示信息。";
    else if (mime.startsWith("image/")) result.kind = "image";
    else if (mime === "application/pdf") result.kind = "pdf";
    else if (info.size <= MAX_PREVIEW_BYTES) {
      const data = await this.bytes(workspaceId, path, MAX_PREVIEW_BYTES);
      if (textual(name, data)) { result.kind = mime === "text/html" ? "html" : "text"; result.text = data.toString("utf8"); }
    }
    if (result.kind === "unsupported") result.notice ||= "此格式或大小暂不支持内嵌预览；Office 文件可下载后打开，未执行格式转换。";
    target.check(); return result;
  }

  async content(workspaceId: string, path: string, options: { download?: boolean } = {}): Promise<ServedFile> {
    const body = await this.bytes(workspaceId, path, MAX_ATTACHMENT_BYTES), name = basename(path), mime = mimeFor(name);
    const passive = mime.startsWith("image/") || mime === "application/pdf" || mime === "text/html";
    return { body, headers: headers(name, mime, options.download === true || !passive) };
  }

  async upload(workspaceId: string, input: { name: string; mime: string; base64: string }): Promise<AttachmentRef> {
    const workspace = this.workspaces.get(workspaceId), check = this.workspaces.lease(workspaceId);
    const name = safeName(input.name);
    if (typeof input.base64 !== "string" || input.base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || input.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw new Error("Invalid or oversized upload (maximum 8 MiB)");
    const body = Buffer.from(input.base64, "base64");
    if (!body.length || body.length > MAX_ATTACHMENT_BYTES || body.toString("base64") !== input.base64) throw new Error("Invalid or oversized attachment: must contain 1 byte to 8 MiB");
    let mime = mimeFor(name);
    if (mime.startsWith("image/")) {
      const valid = mime === "image/png" ? body.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : mime === "image/jpeg" ? body[0] === 255 && body[1] === 216 && body[2] === 255 : mime === "image/gif" ? /^GIF8[79]a$/.test(body.subarray(0, 6).toString()) : body.subarray(0, 4).toString() === "RIFF" && body.subarray(8, 12).toString() === "WEBP";
      if (!valid) throw new Error("Image content does not match its file format");
    } else if (textual(name, body)) mime = mime === "application/octet-stream" ? "text/plain" : mime;
    // Client MIME is only a hint; active formats are never promoted to raster images.
    await ensurePrivateDirectory(this.attachmentDirectory);
    const id = randomUUID(), result: AttachmentRef = { type: "attachment", id, name, mime, size: body.length, workspaceId };
    check();
    await writeFile(join(this.attachmentDirectory, `${id}.bin`), body, { mode: 0o600, flag: "wx" });
    await writeFile(join(this.attachmentDirectory, `${id}.json`), JSON.stringify({ ...result, workspacePath: workspace.path, sha256: createHash("sha256").update(body).digest("hex") }), { mode: 0o600, flag: "wx" });
    check(); return result;
  }

  async attachment(workspaceId: string, id: string, options: { download?: boolean } = {}): Promise<ServedFile> {
    const workspace = this.workspaces.get(workspaceId), check = this.workspaces.lease(workspaceId); validId(id);
    const metadata = JSON.parse((await this.privateRead(this.attachmentDirectory, `${id}.json`, 4096)).toString());
    if (metadata.workspaceId !== workspaceId || metadata.workspacePath !== workspace.path || metadata.id !== id) throw new Error("Attachment does not belong to this workspace");
    const body = await this.privateRead(this.attachmentDirectory, `${id}.bin`, MAX_ATTACHMENT_BYTES);
    if (body.length !== metadata.size || createHash("sha256").update(body).digest("hex") !== metadata.sha256) throw new Error("Attachment integrity check failed");
    check(); return { body, headers: headers(safeName(metadata.name), mimeFor(metadata.name), options.download !== false || !String(metadata.mime).startsWith("image/")) };
  }

  private async privateRead(directory: string, name: string, maxBytes: number): Promise<Buffer> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("Resource store must be a private directory");
    const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(); if (!info.isFile() || info.size > maxBytes || (info.mode & 0o077) !== 0) throw new Error("Invalid private resource");
      const data = Buffer.alloc(info.size + 1), { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (bytesRead !== info.size) throw new Error("Private resource changed while reading");
      return data.subarray(0, bytesRead);
    }
    finally { await handle.close(); }
  }

  private async snapshot(workspaceId: string): Promise<Snapshot> {
    const workspace = this.workspaces.get(workspaceId), check = this.workspaces.lease(workspaceId);
    let paths: string[], partial = false;
    try { const result = await exec("/usr/bin/git", ["-c", "core.fsmonitor=false", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: workspace.path, timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", HOME: homedir(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" } }); paths = [...new Set(result.stdout.split("\0").filter(path => path && allowedPath(path)))]; }
    catch { const found = await this.search(workspaceId, ""); paths = found.entries.filter(entry => entry.kind === "file").map(entry => entry.path); partial = found.truncated; }
    const files: Record<string, string> = {}; let bytes = 0;
    for (const path of paths) {
      if (Object.keys(files).length >= MAX_SNAPSHOT_FILES || bytes >= MAX_SNAPSHOT_BYTES) { partial = true; break; }
      try { const data = await this.bytes(workspaceId, path, MAX_PREVIEW_BYTES); if (textual(path, data)) { if (bytes + data.length > MAX_SNAPSHOT_BYTES) { partial = true; continue; } files[path] = data.toString("utf8"); bytes += data.length; } }
      catch { partial = true; }
    }
    check(); return { workspaceId, files, partial };
  }

  async beginTurn(workspaceId: string, turnId: string, sessionId?: string): Promise<boolean> {
    validId(turnId);
    try { await this.changes(workspaceId, turnId); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const before = await this.snapshot(workspaceId); await ensurePrivateDirectory(this.snapshotDirectory);
    try { await writeFile(join(this.snapshotDirectory, `${workspaceId}-${turnId}.before.json`), JSON.stringify({ ...before, ...(sessionId ? { sessionId } : {}) }), { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return true;
  }

  async finishTurn(workspaceId: string, turnId: string, options: { aborted?: boolean; partialReason?: string; execution?: TurnExecution } = {}): Promise<ChangeSet> {
    validId(turnId); const check = this.workspaces.lease(workspaceId);
    try { return await this.changes(workspaceId, turnId); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const before: Snapshot = JSON.parse((await this.privateRead(this.snapshotDirectory, `${workspaceId}-${turnId}.before.json`, MAX_SNAPSHOT_BYTES * 3)).toString());
    if (before.workspaceId !== workspaceId) throw new Error("Snapshot workspace mismatch");
    const after = await this.snapshot(workspaceId), files: FileChange[] = [];
    for (const path of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
      const old = before.files[path], next = after.files[path];
      if (old === next || (next === undefined && after.partial)) continue;
      files.push({ path, status: old === undefined ? "added" : next === undefined ? "deleted" : "modified", before: old || "", after: next || "", diff: diff(path, old || "", next || "") });
    }
    const result: ChangeSet = { turnId, files, partial: options.aborted === true || !!options.partialReason || before.partial || after.partial, notice: `${options.partialReason || (options.aborted ? "回合已中断，保留已发生的文件变化。 " : "")}仅对比可读取的文本文件；忽略隐藏、敏感、构建目录及 Git 忽略文件，最多 200 个文件 / 4 MiB。并发工作区操作也可能计入变化。` };
    if (options.execution) result.execution = options.execution;
    check();
    try { await writeFile(join(this.snapshotDirectory, `${workspaceId}-${turnId}.changes.json`), JSON.stringify(result), { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return await this.changes(workspaceId, turnId); throw error; }
    await rm(join(this.snapshotDirectory, `${workspaceId}-${turnId}.before.json`), { force: true }); return result;
  }

  async discardTurn(workspaceId: string, turnId: string): Promise<void> {
    this.workspaces.get(workspaceId); validId(turnId);
    await rm(join(this.snapshotDirectory, `${workspaceId}-${turnId}.before.json`), { force: true });
  }

  async changes(workspaceId: string, turnId: string): Promise<ChangeSet> {
    validId(turnId); const check = this.workspaces.lease(workspaceId);
    const result = JSON.parse((await this.privateRead(this.snapshotDirectory, `${workspaceId}-${turnId}.changes.json`, MAX_SNAPSHOT_BYTES * 8)).toString()) as ChangeSet;
    check(); return result;
  }

  async recordSessionTurn(workspaceId: string, sessionId: string, turnId: string): Promise<void> {
    const check = this.workspaces.lease(workspaceId); validId(turnId);
    const key = createHash("sha256").update(sessionId).digest("hex");
    await writePrivateFileAtomically(join(this.snapshotDirectory, `${workspaceId}-${key}.latest.json`), JSON.stringify({ turnId }));
    check();
  }

  async sessionChanges(workspaceId: string, sessionId: string): Promise<ChangeSet | null> {
    const check = this.workspaces.lease(workspaceId), key = createHash("sha256").update(sessionId).digest("hex");
    try {
      const latest = JSON.parse((await this.privateRead(this.snapshotDirectory, `${workspaceId}-${key}.latest.json`, 4096)).toString());
      const result = await this.changes(workspaceId, latest.turnId);
      // Snapshot JSON cannot assert its own acceptance, including old cached projections.
      delete result.verification;
      const candidate = await this.candidateReader?.(workspaceId, result);
      if (candidate) result.verification = candidate;
      else if (this.verification) result.verification = await readWorkspaceVerification(this.verification, this.workspaces.get(workspaceId).path, result);
      check(); return result;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  async recoverPending(): Promise<void> {
    let names: string[];
    try { names = await readdir(this.snapshotDirectory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of names.filter(name => /^[a-f0-9]{16}-[a-f0-9]{64}\.before\.json$/.test(name)).slice(0, 32)) {
      const workspaceId = name.slice(0, 16), turnId = name.slice(17, 81);
      if (!this.workspaces.list().some(workspace => workspace.id === workspaceId)) continue;
      const before = JSON.parse((await this.privateRead(this.snapshotDirectory, name, MAX_SNAPSHOT_BYTES * 3)).toString()) as Snapshot;
      if (before.workspaceId !== workspaceId || typeof before.sessionId !== "string" || before.sessionId.length > 256) continue;
      await this.finishTurn(workspaceId, turnId, { partialReason: "Web Host 启动时发现未完成的快照，比较截止到本次恢复时；代理可能仍在运行。 " });
      await this.recordSessionTurn(workspaceId, before.sessionId, turnId);
    }
  }
}
