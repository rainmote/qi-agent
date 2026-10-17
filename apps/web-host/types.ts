export interface Workspace {
  id: string;
  name: string;
  path: string;
  addedAt: string;
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  path: string;
  name: string | null;
  label: string | null;
  eventCount: number;
  messageCount: number;
  updatedAt: string | null;
  presetId?: string;
}

export interface AgentPresetSummary {
  id: string;
  name: string;
  description?: string;
  order?: number;
  trust: "system" | "user";
  broken?: boolean;
}

export interface WorkerMessage {
  type: "ready" | "response" | "event" | "run-result" |
    "snapshot.begin" | "snapshot.chunk" | "snapshot.end";
  version: number;
  id?: string;
  ok?: boolean;
  result?: unknown;
  error?: { message: string; data?: unknown };
  event?: string;
  data?: Record<string, unknown>;
  session_id?: string;
  transfer_id?: string;
  chunks?: number;
  index?: number;
  [key: string]: unknown;
}

export interface HostEvent extends WorkerMessage {
  hostEpoch: string;
  hostSeq: number;
}

export type ReplayResetReason = "initial" | "invalid-cursor" | "generation" | "buffer-gap";

export interface EventReplay {
  reset: ReplayResetReason | null;
  events: HostEvent[];
}

export interface ProviderReloadResult {
  scope: "open-web-sessions";
  applied: string[];
  failures: Array<{ sessionId: string; sessionName: string; message: string }>;
  warnings?: Array<{ sessionId: string; sessionName: string; message: string }>;
}
