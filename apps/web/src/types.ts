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

export interface DurableEvent {
  id: string;
  seq: number;
  at: string;
  type: string;
  data: Record<string, unknown>;
  parent_id?: string;
}

export interface ModelEntry {
  id: string;
  provider?: string;
  model?: string;
}

export interface Interaction {
  id: string;
  title: string;
  message: string;
  createdAt?: string;
  "created-at"?: string;
  items: Array<{ label: string; value: "allow" | "allow-session" | "deny" }>;
  default: "allow" | "allow-session" | "deny";
}

export interface SessionSnapshot {
  session_id: string;
  path: string;
  cursor: { generation: number; sequence: number };
  events: DurableEvent[];
  state: AgentState;
  models: { current: ModelEntry | null; providers: ModelEntry[] } | null;
  interactions: Interaction[];
}

export interface AgentState {
  phase: "idle" | "model" | "tool" | "retry" | "compacting" | string;
  "run-id"?: string | null;
  partialAssistant?: string;
  partialReasoning?: string;
  "partial-assistant"?: string;
  "partial-reasoning"?: string;
  attempt?: number | null;
  "last-error"?: string;
}

export interface HostEvent {
  hostSeq: number;
  version: number;
  type: "event" | "run-result";
  event?: string;
  event_id?: string;
  session_id?: string;
  seq?: number;
  durable?: boolean;
  at?: string;
  data?: Record<string, unknown>;
  ok?: boolean;
  result?: unknown;
  error?: { message: string };
}

export interface RuntimeStatus {
  plugins: Array<{ id: string; namespace: string; description: string }>;
  tools: Array<{ name: string; description: string; parameters?: unknown }>;
  commands: Array<{ name: string; description: string }>;
  resources?: { skills?: unknown[]; contexts?: unknown[]; prompts?: unknown[] };
}

export interface SubagentStatus {
  providers: Array<{ id: string; description?: string; capabilities?: Record<string, unknown> }>;
  jobs: Array<{ id: string; label: string; provider: string; status: string; result?: unknown }>;
}
