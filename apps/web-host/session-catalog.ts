import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionSummary, Workspace } from "./types.js";

interface SessionMetadata {
  id: string | null;
  name: string | null;
  label: string | null;
  eventCount: number;
  messageCount: number;
  updatedAt: string | null;
}

interface Fingerprint {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface CatalogEntry {
  fingerprint: Fingerprint;
  metadata: SessionMetadata;
  visibleMetadata: SessionMetadata;
  pending: Buffer;
  prefix: Buffer;
  tail: Buffer;
  workspaceId: string;
}

export interface CatalogStatistics {
  directoryReads: number;
  fullReads: number;
  incrementalReads: number;
  cacheHits: number;
  bytesRead: number;
  parsedLines: number;
  peakConcurrentReads: number;
}

const READ_CHUNK = 64 * 1024;
const APPEND_GUARD = 1024;

function fingerprint(info: BigIntStats): Fingerprint {
  const size = Number(info.size);
  if (!Number.isSafeInteger(size)) throw new Error("Session file is too large to index");
  return {
    dev: info.dev, ino: info.ino, birthtimeNs: info.birthtimeNs, size,
    mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs,
  };
}

function sameFile(left: Fingerprint, right: Fingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.birthtimeNs === right.birthtimeNs;
}

function sameVersion(left: Fingerprint, right: Fingerprint): boolean {
  return sameFile(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function emptyMetadata(): SessionMetadata {
  return { id: null, name: null, label: null, eventCount: 0, messageCount: 0, updatedAt: null };
}

/** An in-memory index of append-only transcripts. No worker or credentials are opened. */
export class SessionCatalog {
  readonly concurrency: number;
  #entries = new Map<string, CatalogEntry>();
  #ids = new Map<string, Set<string>>();
  #describing = new Map<string, Promise<SessionSummary | null>>();
  #listing = new Map<string, Promise<SessionSummary[]>>();
  #invalidated = new Map<string, number>();
  #active = 0;
  #waiting: Array<() => void> = [];
  #statistics: CatalogStatistics = {
    directoryReads: 0, fullReads: 0, incrementalReads: 0, cacheHits: 0,
    bytesRead: 0, parsedLines: 0, peakConcurrentReads: 0,
  };

  constructor(concurrency = 8) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Catalog concurrency must be a positive integer");
    }
    this.concurrency = concurrency;
  }

  /** Counters measure actual catalog work, rather than estimated speedups. */
  get statistics(): CatalogStatistics {
    return { ...this.#statistics };
  }

  async list(workspace: Workspace): Promise<SessionSummary[]> {
    let listing = this.#listing.get(workspace.id);
    if (!listing) {
      listing = this.scan(workspace);
      this.#listing.set(workspace.id, listing);
      void listing.finally(() => {
        if (this.#listing.get(workspace.id) === listing) this.#listing.delete(workspace.id);
      }).catch(() => undefined);
    }
    return (await listing).map((summary) => ({ ...summary }));
  }

  async find(id: string, workspaces: Workspace[]): Promise<SessionSummary | null> {
    const allowed = new Set(workspaces.map((workspace) => workspace.id));
    for (const path of [...(this.#ids.get(id) || [])]) {
      const entry = this.#entries.get(path);
      if (!entry || !allowed.has(entry.workspaceId)) continue;
      const summary = await this.describe(path, entry.workspaceId);
      if (summary?.id === id) return summary;
    }
    // A cold lookup or a moved transcript needs discovery. Warm, valid IDs
    // touch only their own file, not every allowlisted workspace.
    for (const workspace of workspaces) {
      const found = (await this.list(workspace)).find((summary) => summary.id === id);
      if (found) return found;
    }
    return null;
  }

  async describe(path: string, workspaceId: string): Promise<SessionSummary | null> {
    let describing = this.#describing.get(path);
    if (!describing) {
      const generation = this.#invalidated.get(path) || 0;
      describing = this.limited(() => this.refresh(path, workspaceId, generation));
      this.#describing.set(path, describing);
      void describing.finally(() => {
        if (this.#describing.get(path) === describing) this.#describing.delete(path);
      }).catch(() => undefined);
    }
    const summary = await describing;
    return summary ? { ...summary, workspaceId } : null;
  }

  invalidate(path: string): void {
    this.#invalidated.set(path, (this.#invalidated.get(path) || 0) + 1);
    this.removeEntry(path);
  }

  private removeEntry(path: string): void {
    const id = this.#entries.get(path)?.visibleMetadata.id;
    if (id) {
      const paths = this.#ids.get(id);
      paths?.delete(path);
      if (!paths?.size) this.#ids.delete(id);
    }
    this.#entries.delete(path);
  }

  private summary(path: string, entry: CatalogEntry): SessionSummary | null {
    const { id, ...metadata } = entry.visibleMetadata;
    return id ? { ...metadata, id, path, workspaceId: entry.workspaceId } : null;
  }

  private async scan(workspace: Workspace): Promise<SessionSummary[]> {
    const directories = [
      join(workspace.path, ".qi-agent", "sessions"),
      join(workspace.path, ".bb-agent", "sessions"),
    ];
    const files = (await Promise.all(directories.map((directory) => this.limited(async () => {
      this.#statistics.directoryReads += 1;
      try {
        const [root, sessions] = await Promise.all([lstat(dirname(directory)), lstat(directory)]);
        if (!root.isDirectory() || !sessions.isDirectory()) return [];
        return (await readdir(directory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => join(directory, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    })))).flat();
    const present = new Set(files);
    for (const [path, entry] of this.#entries) {
      if (entry.workspaceId === workspace.id && !present.has(path)) this.invalidate(path);
    }
    const summaries = await Promise.all(files.map((path) => this.describe(path, workspace.id)));
    return summaries.filter((summary): summary is SessionSummary => summary !== null);
  }

  private async limited<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.concurrency) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    } else {
      this.#active += 1;
    }
    this.#statistics.peakConcurrentReads = Math.max(this.#statistics.peakConcurrentReads, this.#active);
    try {
      return await operation();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#active -= 1;
    }
  }

  private async readRange(file: FileHandle, start: number, length: number): Promise<Buffer> {
    const data = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await file.read(data, offset, length - offset, start + offset);
      this.#statistics.bytesRead += bytesRead;
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return data.subarray(0, offset);
  }

  private applyLine(metadata: SessionMetadata, line: Buffer): void {
    const text = line.toString("utf8").trim();
    if (!text) return;
    this.#statistics.parsedLines += 1;
    try {
      const event = JSON.parse(text) as {
        type?: string; at?: string; data?: Record<string, unknown>;
      } | null;
      if (!event || typeof event !== "object" || Array.isArray(event)) return;
      metadata.eventCount += 1;
      metadata.updatedAt = event.at || metadata.updatedAt;
      if (event.type === "session/start" || event.type === "session/fork") {
        metadata.id = String(event.data?.session_id || metadata.id || "") || null;
      }
      if (event.type === "session/name") metadata.name = String(event.data?.name || "") || null;
      if (event.type === "session/label") metadata.label = String(event.data?.label || "") || null;
      if (event.type === "message") metadata.messageCount += 1;
    } catch {
      // A half-written final JSON object does not hide earlier valid events.
    }
  }

  private async refresh(path: string, workspaceId: string, generation: number,
    attempt = 0): Promise<SessionSummary | null> {
    let file: FileHandle | undefined;
    try {
      const [root, sessions] = await Promise.all([
        lstat(dirname(dirname(path))), lstat(dirname(path)),
      ]);
      if (!root.isDirectory() || !sessions.isDirectory()) {
        this.removeEntry(path);
        return null;
      }
      const pathInfo = await lstat(path, { bigint: true });
      if (!pathInfo.isFile()) {
        this.removeEntry(path);
        return null;
      }
      const previous = this.#entries.get(path);
      const initial = fingerprint(pathInfo);
      if (previous && sameVersion(previous.fingerprint, initial)) {
        this.#statistics.cacheHits += 1;
        return this.summary(path, previous);
      }
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fingerprint(await file.stat({ bigint: true }));
      let incremental = Boolean(previous && sameFile(previous.fingerprint, before)
        && before.size > previous.fingerprint.size);
      if (incremental && previous) {
        // Transcripts are append-only. Bounded prefix/end guards additionally
        // catch truncate-and-regrow and common in-place replacements between
        // scans. An arbitrary edit of the old interior requires invalidation;
        // our writers never perform that operation.
        const prefix = await this.readRange(file, 0, previous.prefix.length);
        const tail = await this.readRange(file,
          previous.fingerprint.size - previous.tail.length, previous.tail.length);
        incremental = prefix.equals(previous.prefix) && tail.equals(previous.tail);
      }
      if (incremental) this.#statistics.incrementalReads += 1;
      else this.#statistics.fullReads += 1;
      const metadata = incremental && previous ? { ...previous.metadata } : emptyMetadata();
      let fragments = incremental && previous?.pending.length ? [previous.pending] : [];
      let fragmentBytes = fragments[0]?.length || 0;
      let prefix = incremental && previous ? previous.prefix : Buffer.alloc(0);
      let tail = incremental && previous ? previous.tail : Buffer.alloc(0);
      let position = incremental && previous ? previous.fingerprint.size : 0;
      while (position < before.size) {
        const bytes = await this.readRange(file, position, Math.min(READ_CHUNK, before.size - position));
        if (!bytes.length) break;
        position += bytes.length;
        if (prefix.length < APPEND_GUARD) {
          prefix = Buffer.concat([prefix, bytes.subarray(0, APPEND_GUARD - prefix.length)]);
        }
        tail = Buffer.from(Buffer.concat([tail, bytes]).subarray(-APPEND_GUARD));
        let start = 0;
        let end: number;
        while ((end = bytes.indexOf(0x0a, start)) !== -1) {
          const part = bytes.subarray(start, end);
          if (fragments.length) {
            fragments.push(part);
            this.applyLine(metadata, Buffer.concat(fragments, fragmentBytes + part.length));
            fragments = [];
            fragmentBytes = 0;
          } else {
            this.applyLine(metadata, part);
          }
          start = end + 1;
        }
        if (start < bytes.length) {
          const fragment = Buffer.from(bytes.subarray(start));
          fragments.push(fragment);
          fragmentBytes += fragment.length;
        }
      }
      const after = fingerprint(await file.stat({ bigint: true }));
      const currentPathInfo = await lstat(path, { bigint: true });
      const current = fingerprint(currentPathInfo);
      // Do not cache mixed versions after a truncate/replacement during reads.
      // A concurrently appended suffix is safely picked up next time.
      if (position !== before.size || !sameFile(before, current) || !currentPathInfo.isFile()
        || after.size < before.size || current.size < before.size
        || (after.size === before.size && !sameVersion(before, after))) {
        await file.close();
        file = undefined;
        this.removeEntry(path);
        return attempt < 2 ? this.refresh(path, workspaceId, generation, attempt + 1) : null;
      }
      const pending = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments, fragmentBytes);
      const visibleMetadata = { ...metadata };
      // Support a valid last JSON object without a newline, but retain it as
      // pending so adding its newline later cannot count it twice.
      if (pending.length) this.applyLine(visibleMetadata, pending);
      const entry: CatalogEntry = {
        fingerprint: before, metadata, visibleMetadata, pending, prefix, tail, workspaceId,
      };
      if (generation !== (this.#invalidated.get(path) || 0)) return null;
      this.removeEntry(path);
      this.#entries.set(path, entry);
      if (visibleMetadata.id) {
        const paths = this.#ids.get(visibleMetadata.id) || new Set<string>();
        paths.add(path);
        this.#ids.set(visibleMetadata.id, paths);
      }
      return this.summary(path, entry);
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code || "")) {
        this.removeEntry(path);
        return null;
      }
      throw error;
    } finally {
      await file?.close();
    }
  }
}
