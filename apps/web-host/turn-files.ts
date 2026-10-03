import type { AgentWorker } from "./worker.js";
import type { HostEvent } from "./types.js";
import type { WorkspaceFiles } from "./workspace-files.js";
import { createHash } from "node:crypto";

export const snapshotTurnId = (sessionId: string, commandId: string): string =>
  createHash("sha256").update(JSON.stringify([sessionId, commandId])).digest("hex");

/** Holds the event subscription through disconnects of the browser, and deduplicates command retries. */
export class TurnFiles {
  private active = new Map<string, { ready: () => Promise<unknown>; admit: (result: unknown) => void; finish: (aborted: boolean) => Promise<void>; discard: () => Promise<void> }>();
  constructor(private files: WorkspaceFiles) {}
  async begin(worker: AgentWorker, workspaceId: string, sessionId: string, commandId: string): Promise<void> {
    const turnId = snapshotTurnId(sessionId, commandId);
    const key = `${workspaceId}:${turnId}`;
    const existing = this.active.get(key);
    if (existing) { await existing.ready(); return; }
    // Register before awaiting the snapshot so concurrent retries cannot attach two listeners.
    let started!: Promise<boolean>;
    let finished: Promise<void> | undefined;
    let release: (() => void) | undefined;
    let requestId: string | undefined;
    const early = new Map<string, HostEvent>();
    const cleanup = () => { worker.off("event", onEvent); worker.off("exit", onExit); worker.off("reset", onExit); release?.(); this.active.delete(key); };
    const finish = (aborted: boolean): Promise<void> => finished ||= (async () => {
      try { await started; await this.files.finishTurn(workspaceId, turnId, { aborted }); await this.files.recordSessionTurn(workspaceId, sessionId, turnId); }
      finally { cleanup(); }
    })();
    const onEvent = (event: HostEvent) => {
      if (event.event !== "remote/run-result" || typeof event.data?.request_id !== "string") return;
      if (!requestId) { if (early.size >= 128) early.delete(early.keys().next().value!); early.set(event.data.request_id, event); return; }
      if (event.data.request_id !== requestId) return;
      const result = event.data.result as { aborted?: boolean } | undefined;
      void finish(event.data.ok !== true || result?.aborted === true).catch(() => undefined);
    };
    const onExit = () => { void finish(true).catch(() => undefined); };
    this.active.set(key, { ready: () => started, admit: result => {
      const admission = result as { request_id?: unknown } | undefined;
      if (typeof admission?.request_id !== "string") { void finish(true).catch(() => undefined); return; }
      requestId = admission.request_id;
      const completed = early.get(requestId); early.clear(); if (completed) onEvent(completed);
    }, finish, discard: async () => { await started.catch(() => undefined); cleanup(); await this.files.discardTurn(workspaceId, turnId); } });
    started = this.files.beginTurn(workspaceId, turnId, sessionId);
    try { if (await started === false) { cleanup(); return; } release = worker.subscribeClient(); worker.on("event", onEvent); worker.on("exit", onExit); worker.on("reset", onExit); }
    catch (error) { cleanup(); throw error; }
  }
  admit(workspaceId: string, sessionId: string, commandId: string, result: unknown): void { this.active.get(`${workspaceId}:${snapshotTurnId(sessionId, commandId)}`)?.admit(result); }
  reconcile(sessionId: string, commandId: string, result: unknown): void {
    const turnId = snapshotTurnId(sessionId, commandId);
    for (const [key, turn] of this.active) if (key.endsWith(`:${turnId}`)) turn.admit(result);
  }
  async rejectReconciled(sessionId: string, commandId: string): Promise<void> {
    const turnId = snapshotTurnId(sessionId, commandId);
    await Promise.all([...this.active].filter(([key]) => key.endsWith(`:${turnId}`)).map(([, turn]) => turn.discard()));
  }
  async reject(workspaceId: string, sessionId: string, commandId: string): Promise<void> { await this.active.get(`${workspaceId}:${snapshotTurnId(sessionId, commandId)}`)?.discard(); }
  async close(): Promise<void> { await Promise.allSettled([...this.active.values()].map(turn => turn.finish(true))); }
}
