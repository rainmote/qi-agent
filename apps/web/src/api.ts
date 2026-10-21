import { mutation } from "../../shared/methods";
import { uiText as t } from "./i18n";
import type { AttachmentRef, ChangeSet, FileListing, FilePreview } from "../../web-host/workspace-files";
import type { AgentPresetSummary, HostEvent, ProviderInput, ProviderModelSettings, ProviderPreset, ProviderSettings, ProviderReloadResult,
  SessionSnapshot, SessionSummary, Workspace } from "./types";

interface ApiEnvelope<T> {
  ok: boolean;
  result: T;
  error?: { message: string; data?: { status?: string; command_id?: string; type?: string } };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const value = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !value.ok) throw Object.assign(new Error(value.error?.message || `Request failed (${response.status})`), { data: value.error?.data, definitive: true });
  return value.result;
}

export interface Bootstrap {
  workspaces: Workspace[];
  catalogs: Array<{ workspaceId: string; sessions: SessionSummary[] }>;
  activeWorkspaceId: string | null;
}

export interface PendingOperation {
  sessionId: string;
  commandId: string;
  method: string;
  params: Record<string, unknown>;
}
export interface OperationStatus {
  status: "not_found" | "pending" | "completed" | "failed";
  result?: unknown;
  error?: { message?: string };
}
const storageKey = (id: string) => `qi-agent.pending-operation:${id}`;
// Keep the original identity through page/host reloads. Persist before sending;
// if storage is unavailable we reject before any effect can be dispatched.
export function pendingOperation(id: string): PendingOperation | null {
  return JSON.parse(sessionStorage.getItem(storageKey(id)) || "null") as PendingOperation | null;
}
export function uncertainOperation(error: unknown): boolean {
  return (error as { data?: { status?: string } } | null)?.data?.status === "uncertain";
}
function unknownOutcome(operation: PendingOperation): Error {
  return Object.assign(new Error(t("操作结果尚未确认，请先核对结果，避免重复执行。")), {
    data: { status: "uncertain", command_id: operation.commandId },
  });
}
function clearOperation(operation: PendingOperation) {
  // A late response/query owns only its captured identity. A newer operation
  // may already be journaled after the old receipt was reconciled elsewhere.
  if (pendingOperation(operation.sessionId)?.commandId === operation.commandId) {
    sessionStorage.removeItem(storageKey(operation.sessionId));
  }
}
async function submitOperation<T>(operation: PendingOperation): Promise<T> {
  sessionStorage.setItem(storageKey(operation.sessionId), JSON.stringify(operation));
  try {
    const result = await request<T>(`/api/sessions/${encodeURIComponent(operation.sessionId)}/rpc`, {
      method: "POST", body: JSON.stringify(operation),
    });
    clearOperation(operation);
    return result;
  } catch (error) {
    if ((error as { definitive?: boolean }).definitive && !uncertainOperation(error)) {
      clearOperation(operation);
      throw error;
    }
    throw unknownOutcome(operation);
  }
}
async function operationStatus(id: string): Promise<OperationStatus> {
  const operation = pendingOperation(id);
  if (!operation) throw new Error(t("没有需要核对的操作"));
  const result = await request<OperationStatus>(
    `/api/sessions/${encodeURIComponent(id)}/operations/${encodeURIComponent(operation.commandId)}`);
  if (result.status === "completed" || result.status === "failed") clearOperation(operation);
  return result;
}

export const api = {
  workspaceFiles: {
    list: (id: string, path: string, signal: AbortSignal) => request<FileListing>(`/api/workspaces/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`, { signal }),
    search: (id: string, query: string, signal: AbortSignal) => request<FileListing>(`/api/workspaces/${encodeURIComponent(id)}/search?q=${encodeURIComponent(query)}`, { signal }),
    preview: (id: string, path: string, signal: AbortSignal) => request<FilePreview>(`/api/workspaces/${encodeURIComponent(id)}/preview?path=${encodeURIComponent(path)}`, { signal }),
    contentUrl: (id: string, path: string, download = false) => `/api/workspaces/${encodeURIComponent(id)}/content?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`,
    changes: (id: string, sessionId: string, signal: AbortSignal) => request<ChangeSet | null>(`/api/workspaces/${encodeURIComponent(id)}/changes?session=${encodeURIComponent(sessionId)}`, { signal }),
  },
  uploadAttachment: (id: string, input: { name: string; mime: string; base64: string }, signal: AbortSignal) => request<AttachmentRef>(`/api/workspaces/${encodeURIComponent(id)}/attachments`, { method: "POST", body: JSON.stringify(input), signal }),
  referenceSuggestions: (id: string, query: string, signal: AbortSignal) => request<{ files: FileListing["entries"]; sessions: SessionSummary[] }>(`/api/workspaces/${encodeURIComponent(id)}/references?q=${encodeURIComponent(query)}`, { signal }),
  resolveReferences: (id: string, message: string) => request<string>(`/api/workspaces/${encodeURIComponent(id)}/resolve-references`, { method: "POST", body: JSON.stringify({ message }) }),
  bootstrap: () => request<Bootstrap>("/api/bootstrap"),
  listPresets: () => request<AgentPresetSummary[]>("/api/presets"),
  listProviders: () => request<{ providers: ProviderSettings[]; presets: ProviderPreset[] }>("/api/providers"),
  saveProvider: (provider: ProviderInput) =>
    request<ProviderSettings & { reload: ProviderReloadResult }>("/api/providers", {
      method: "POST",
      body: JSON.stringify(provider),
    }),
  removeProvider: (id: string) => request<{ removed: boolean; reload: ProviderReloadResult }>(
    `/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  reloadProviders: (sessionIds: string[]) => request<ProviderReloadResult>("/api/providers/reload", {
    method: "POST", body: JSON.stringify({ sessionIds }),
  }),
  discoverProviderModels: (input: { providerId?: string; baseUrl?: string; apiKey?: string }) =>
    request<ProviderModelSettings[]>("/api/providers/discover", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listSessions: (workspaceId: string) =>
    request<SessionSummary[]>(`/api/sessions?workspace=${encodeURIComponent(workspaceId)}`),
  createSession: (workspaceId: string, name?: string, presetId?: string) =>
    request<{ session: SessionSummary; snapshot: SessionSnapshot; eventCursor?: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspaceId, name, presetId }),
    }),
  openSession: (id: string) =>
    request<{ session: SessionSummary; snapshot: SessionSnapshot; eventCursor?: string }>(
      `/api/sessions/${encodeURIComponent(id)}/open`, { method: "POST", body: "{}" }),
  forkSession: (id: string, name?: string) =>
    request<{ session: SessionSummary; snapshot: SessionSnapshot; eventCursor?: string }>(
      `/api/sessions/${encodeURIComponent(id)}/fork`, {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
  archiveSession: (id: string) => request<{ archived: boolean }>(
    `/api/sessions/${encodeURIComponent(id)}/archive`, { method: "POST", body: "{}" }),
  listDirectories: (path?: string) => request<{
    path: string;
    parent: string | null;
    directories: Array<{ name: string; path: string }>;
  }>(`/api/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  pendingOperation,
  operationStatus,
  retryOperation: async (id: string) => {
    const operation = pendingOperation(id);
    if (!operation) throw new Error(t("没有需要核对的操作"));
    const status = await operationStatus(id);
    if (status.status === "not_found") {
      const current = pendingOperation(id);
      if (current?.commandId !== operation.commandId) throw unknownOutcome(current || operation);
      return submitOperation(operation);
    }
    if (status.status === "completed") return status.result;
    if (status.status === "failed") throw new Error(status.error?.message || t("原操作失败"));
    throw unknownOutcome(operation);
  },
  rpc: <T>(id: string, method: string, params: Record<string, unknown> = {}): Promise<T> => {
    if (!mutation(method)) return request<T>(`/api/sessions/${encodeURIComponent(id)}/rpc`, {
      method: "POST", body: JSON.stringify({ method, params }),
    });
    const pending = pendingOperation(id);
    // Interrupt remains available while the original outcome is uncertain.
    if (pending && !["turn.abort", "repl.interrupt", "interaction.resolve", "planning.cancel", "planning.exit", "terminal.stop", "terminal.cancel"].includes(method)) return Promise.reject(unknownOutcome(pending));
    const operation = { sessionId: id, method, params, commandId: `web-${crypto.randomUUID()}` };
    if (pending) return request<T>(`/api/sessions/${encodeURIComponent(id)}/rpc`, {
      method: "POST", body: JSON.stringify(operation),
    });
    return submitOperation<T>(operation);
  },
  addWorkspace: (path: string) => request<Workspace>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ path }),
  }),
  removeWorkspace: (id: string) => request<{ removed: boolean }>(
    `/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }),
  events: (id: string, onEvent: (event: HostEvent) => void,
    onStatus: (connected: boolean) => void,
    onSnapshot?: (snapshot: SessionSnapshot) => void,
    onRecoveryWarning?: (message: string) => void, eventCursor?: string) => {
    const source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events${
      eventCursor ? `?after=${encodeURIComponent(eventCursor)}` : ""}`);
    source.addEventListener("ready", () => onStatus(true));
    source.addEventListener("snapshot", (raw) => {
      const value = JSON.parse((raw as MessageEvent).data) as {
        snapshot: SessionSnapshot;
        events: HostEvent[];
        warning?: string;
      };
      onSnapshot?.(value.snapshot);
      for (const event of value.events) onEvent(event);
      if (value.warning) onRecoveryWarning?.(value.warning);
    });
    source.addEventListener("worker", (raw) => {
      onEvent(JSON.parse((raw as MessageEvent).data) as HostEvent);
    });
    source.addEventListener("error", () => onStatus(false));
    return () => source.close();
  },
};
