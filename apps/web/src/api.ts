import type { HostEvent, ProviderModelSettings, ProviderPreset, ProviderSettings,
  SessionSnapshot, SessionSummary, Workspace } from "./types";

interface ApiEnvelope<T> {
  ok: boolean;
  result: T;
  error?: { message: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
  });
  const value = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !value.ok) throw new Error(value.error?.message || `Request failed (${response.status})`);
  return value.result;
}

export interface Bootstrap {
  workspaces: Workspace[];
  catalogs: Array<{ workspaceId: string; sessions: SessionSummary[] }>;
  activeWorkspaceId: string | null;
}

export const api = {
  bootstrap: () => request<Bootstrap>("/api/bootstrap"),
  listProviders: () => request<{ providers: ProviderSettings[]; presets: ProviderPreset[] }>("/api/providers"),
  saveProvider: (provider: Omit<ProviderSettings, "apiKeyConfigured"> & { apiKey?: string }) =>
    request<ProviderSettings>("/api/providers", {
      method: "POST",
      body: JSON.stringify(provider),
    }),
  removeProvider: (id: string) => request<{ removed: boolean }>(
    `/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  discoverProviderModels: (input: { providerId?: string; baseUrl?: string; apiKey?: string }) =>
    request<ProviderModelSettings[]>("/api/providers/discover", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listSessions: (workspaceId: string) =>
    request<SessionSummary[]>(`/api/sessions?workspace=${encodeURIComponent(workspaceId)}`),
  createSession: (workspaceId: string, name?: string) =>
    request<{ session: SessionSummary; snapshot: SessionSnapshot }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ workspaceId, name }),
    }),
  openSession: (id: string) =>
    request<{ session: SessionSummary; snapshot: SessionSnapshot }>(
      `/api/sessions/${encodeURIComponent(id)}/open`, { method: "POST", body: "{}" }),
  forkSession: (id: string, name?: string) =>
    request<{ session: SessionSummary; snapshot: SessionSnapshot }>(
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
  rpc: <T>(id: string, method: string, params: Record<string, unknown> = {}) =>
    request<T>(`/api/sessions/${encodeURIComponent(id)}/rpc`, {
      method: "POST",
      body: JSON.stringify({ method, params }),
    }),
  addWorkspace: (path: string) => request<Workspace>("/api/workspaces", {
    method: "POST",
    body: JSON.stringify({ path }),
  }),
  removeWorkspace: (id: string) => request<{ removed: boolean }>(
    `/api/workspaces/${encodeURIComponent(id)}`, { method: "DELETE" }),
  events: (id: string, onEvent: (event: HostEvent) => void,
    onStatus: (connected: boolean) => void) => {
    const source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
    source.addEventListener("open", () => onStatus(true));
    source.addEventListener("worker", (raw) => {
      onEvent(JSON.parse((raw as MessageEvent).data) as HostEvent);
    });
    source.addEventListener("error", () => onStatus(false));
    return () => source.close();
  },
};
