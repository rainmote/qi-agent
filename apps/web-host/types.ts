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
  hostSeq: number;
}
