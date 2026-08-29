import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { Workspace } from "./types.js";

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

  constructor(stateDirectory = defaultStateDirectory()) {
    this.stateDirectory = stateDirectory;
    this.statePath = join(stateDirectory, "workspaces.json");
  }

  async load(defaultRoot?: string): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
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
    const existing = this.#workspaces.get(id);
    if (existing) return existing;
    const workspace: Workspace = {
      id,
      name: basename(canonical) || canonical,
      path: canonical,
      addedAt: new Date().toISOString(),
    };
    this.#workspaces.set(id, workspace);
    await this.save();
    return workspace;
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.#workspaces.delete(id);
    if (removed) await this.save();
    return removed;
  }

  async save(): Promise<void> {
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    await writeFile(temporary,
      `${JSON.stringify({ workspaces: this.list() }, null, 2)}\n`,
      { mode: 0o600 });
    await import("node:fs/promises").then(({ rename }) => rename(temporary, this.statePath));
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
