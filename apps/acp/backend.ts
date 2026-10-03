import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../web-host/sessions.js";
import { WorkspaceRegistry, workspaceId } from "../web-host/workspaces.js";
import { WorkspaceFiles, type AttachmentRef } from "../web-host/workspace-files.js";
import type { DaemonEnvironment } from "../web-host/worker.js";
import { AcpError, type AcpBackend, type AcpSession } from "./protocol.js";

/** Explicit CLI roots, not an IDE-supplied cwd, grant filesystem authority. */
export class LocalAcpBackend implements AcpBackend {
  readonly workspaces: WorkspaceRegistry;
  readonly sessions: SessionManager;
  readonly files: WorkspaceFiles;
  readonly roots: Set<string>;
  private constructor(registry: WorkspaceRegistry, repositoryRoot: string, roots: string[], environment: DaemonEnvironment) {
    this.workspaces = registry; this.roots = new Set(roots);
    this.files = new WorkspaceFiles(registry, { attachmentDirectory: environment.attachmentDirectory });
    this.sessions = new SessionManager(registry, repositoryRoot, environment);
  }
  static async open(options: { stateDirectory: string; repositoryRoot: string; roots: string[]; environment?: DaemonEnvironment }): Promise<LocalAcpBackend> {
    const roots = await Promise.all(options.roots.map((root) => realpath(root)));
    if (!roots.length) throw new AcpError("At least one workspace root is required");
    const registry = new WorkspaceRegistry(options.stateDirectory);
    await registry.load();
    // Do not leave old roots available to SessionManager's session-ID lookup.
    // Their session files remain on disk and can be re-added explicitly later.
    for (const workspace of registry.list()) if (!roots.includes(workspace.path)) await registry.remove(workspace.id);
    for (const root of roots) await registry.add(root);
    return new LocalAcpBackend(registry, options.repositoryRoot, roots, options.environment || {});
  }
  private async root(cwd: string): Promise<string> {
    if (!isAbsolute(cwd)) throw new AcpError("cwd must be absolute");
    const root = await realpath(cwd);
    if (!this.roots.has(root)) throw new AcpError("Workspace is not authorized; start ACP with --workspace for this exact root");
    return root;
  }
  async create(cwd: string): Promise<AcpSession> {
    const root = await this.root(cwd), opened = await this.sessions.create(workspaceId(root));
    return { id: opened.summary.id, cwd: root, title: opened.summary.name || undefined, worker: opened.worker,
      snapshot: opened.snapshot as Record<string, unknown> };
  }
  async load(id: string, cwd?: string): Promise<AcpSession> {
    const entries = await this.list(cwd), summary = entries.find((entry) => entry.sessionId === id);
    if (!summary) throw new AcpError("Session not found in authorized roots");
    const opened = await this.sessions.open(id);
    return { id, cwd: summary.cwd, title: summary.title, worker: opened.worker, snapshot: opened.snapshot as Record<string, unknown> };
  }
  async list(cwd?: string) {
    const roots = cwd ? [await this.root(cwd)] : [...this.roots];
    const summaries = (await Promise.all(roots.map((root) => this.sessions.list(this.workspaces.get(workspaceId(root)))))).flat();
    return summaries.map((summary) => ({ sessionId: summary.id, cwd: this.workspaces.get(summary.workspaceId).path,
      title: summary.name || summary.label || undefined, updatedAt: summary.updatedAt || undefined }))
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") || a.sessionId.localeCompare(b.sessionId));
  }
  async preparePrompt(session: AcpSession, blocks: Record<string, unknown>[]): Promise<Array<{ type: "text"; text: string } | AttachmentRef>> {
    const root = await this.root(session.cwd), id = workspaceId(root);
    const output: Array<{ type: "text"; text: string } | AttachmentRef> = [];
    let size = 0;
    for (const block of blocks) {
      if (block.type === "text") {
        if (typeof block.text !== "string") throw new AcpError("Invalid text block");
        size += Buffer.byteLength(block.text);
        if (size > 256 * 1024) throw new AcpError("Text context exceeds 256 KiB");
        output.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const extension: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
        if (typeof block.mimeType !== "string" || !extension[block.mimeType] || typeof block.data !== "string") throw new AcpError("Use embedded PNG, JPEG, GIF or WebP image data");
        output.push(await this.files.upload(id, { name: `context.${extension[block.mimeType]}`, mime: block.mimeType, base64: block.data }));
      } else if (block.type === "resource") {
        const resource = block.resource as Record<string, unknown> | undefined;
        if (!resource || typeof resource.uri !== "string" || resource.uri.length > 4096 || typeof resource.text !== "string") throw new AcpError("Embedded resources must contain URI and text; binary resources are unsupported");
        size += Buffer.byteLength(resource.text);
        if (size > 256 * 1024) throw new AcpError("Text context exceeds 256 KiB");
        output.push({ type: "text", text: `External context (${JSON.stringify(resource.uri)}):\n${resource.text}` });
      } else if (block.type === "resource_link") {
        if (typeof block.uri !== "string" || !block.uri.startsWith("file:")) throw new AcpError("Resource links support authorized local files only");
        const path = await realpath(fileURLToPath(block.uri)), local = relative(root, path);
        if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new AcpError("Resource link is outside the workspace");
        const file = await this.files.content(id, local.split(sep).join("/"));
        output.push(await this.files.upload(id, { name: basename(path), mime: file.headers["Content-Type"], base64: file.body.toString("base64") }));
      } else throw new AcpError(`Unsupported prompt block: ${String(block.type)}`);
    }
    if (Buffer.byteLength(JSON.stringify(output)) > 256 * 1024) throw new AcpError("Prompt references and text exceed 256 KiB");
    return output;
  }
  async close(): Promise<void> { await this.sessions.closeAll(); }
}
