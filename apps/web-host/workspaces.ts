import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { Workspace } from "./types.js";
import { ensurePrivateDirectory, writePrivateFileAtomically } from "./storage.js";

interface WorkspaceState {
  workspaces: Workspace[];
}

export function workspaceId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

export class WorkspaceRegistry {
  readonly stateDirectory: string;
  readonly statePath: string;
  #workspaces = new Map<string, Workspace>();
  #mutations = Promise.resolve();
  #generations = new Map<string, number>();
  #revocations = new Set<(id: string) => Promise<void>>();

  onRevoke(listener: (id: string) => Promise<void>): () => void {
    this.#revocations.add(listener);
    return () => this.#revocations.delete(listener);
  }

  lease(id: string): () => void {
    const workspace = this.get(id);
    const generation = this.#generations.get(id) || 0;
    return () => {
      if (this.#workspaces.get(id) !== workspace || (this.#generations.get(id) || 0) !== generation) {
        throw new Error("Workspace access was revoked");
      }
    };
  }

  constructor(stateDirectory = defaultStateDirectory()) {
    this.stateDirectory = stateDirectory;
    this.statePath = join(stateDirectory, "workspaces.json");
  }

  async load(defaultRoot?: string): Promise<void> {
    await ensurePrivateDirectory(this.stateDirectory);
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as WorkspaceState;
      for (const workspace of parsed.workspaces || []) {
        try {
          const canonical = await this.canonicalDirectory(workspace.path);
          this.#workspaces.set(workspaceId(canonical), {
            ...workspace,
            id: workspaceId(canonical),
            path: canonical,
          });
        } catch {
          // Stale roots are omitted until the user adds them again.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (defaultRoot) await this.add(defaultRoot);
    else await this.save();
  }

  list(): Workspace[] {
    return [...this.#workspaces.values()].sort((a, b) =>
      a.name.localeCompare(b.name));
  }

  get(id: string): Workspace {
    const workspace = this.#workspaces.get(id);
    if (!workspace) throw new Error("Workspace is not allowlisted");
    return workspace;
  }

  async add(path: string): Promise<Workspace> {
    const canonical = await this.canonicalDirectory(path);
    const id = workspaceId(canonical);
    return this.mutate(async () => {
      const existing = this.#workspaces.get(id);
      if (existing) return existing;
      const workspace: Workspace = {
        id,
        name: basename(canonical) || canonical,
        path: canonical,
        addedAt: new Date().toISOString(),
      };
      this.#workspaces.set(id, workspace);
      try {
        await this.save();
        return workspace;
      } catch (error) {
        this.#workspaces.delete(id);
        throw error;
      }
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const existing = this.#workspaces.get(id);
      if (!existing) return false;
      this.#workspaces.delete(id);
      this.#generations.set(id, (this.#generations.get(id) || 0) + 1);
      await Promise.allSettled([...this.#revocations].map((listener) => listener(id)));
      try {
        await this.save();
        return true;
      } catch (error) {
        this.#workspaces.set(id, existing);
        throw error;
      }
    });
  }

  private async save(): Promise<void> {
    await writePrivateFileAtomically(this.statePath,
      `${JSON.stringify({ workspaces: this.list() }, null, 2)}\n`);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutations.catch(() => undefined).then(operation);
    this.#mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private async canonicalDirectory(path: string): Promise<string> {
    const canonical = await realpath(path);
    const info = await stat(canonical);
    if (!info.isDirectory()) throw new Error("Workspace must be a directory");
    return canonical;
  }
}

function defaultStateDirectory(): string {
  if (process.env.QI_AGENT_WEB_STATE_DIR) return process.env.QI_AGENT_WEB_STATE_DIR;
  if (process.env.BB_AGENT_WEB_STATE_DIR) return process.env.BB_AGENT_WEB_STATE_DIR;
  if (process.env.QI_AGENT_HOME) return join(process.env.QI_AGENT_HOME, "web");
  const canonical = join(homedir(), ".qi-agent", "web");
  const legacy = join(homedir(), ".bb-agent", "web");
  return existsSync(canonical) || !existsSync(legacy) ? canonical : legacy;
}
