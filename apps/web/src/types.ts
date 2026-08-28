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
  "display-name"?: string;
  "settings-provider-id"?: string;
}

export type ProviderProtocol = "openai-completions" | "openai-responses" | "anthropic-messages"
  | "chatgpt-subscription";
export type ProviderAuthType = "api-key" | "chatgpt-subscription";
export type ProviderAuthStatus = "configured" | "missing" | "invalid" | "expired" | "insecure";

export interface ProviderModelSettings {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface ProviderSettings {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKeyConfigured: boolean;
  authType: ProviderAuthType;
  authStatus: ProviderAuthStatus;
  authSource?: "settings" | "environment" | "codex-auth-cache";
  authFile?: string;
  models: ProviderModelSettings[];
  builtin?: boolean;
}

export type ProviderInput = Omit<ProviderSettings,
  "apiKeyConfigured" | "authType" | "authStatus" | "authSource" | "authFile"> & { apiKey?: string };

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
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
  policy?: PolicyStatus | null;
}

export interface PolicyStatus {
  mode: "deny" | "ask" | "allow";
  modes: Array<{ id: "deny" | "ask" | "allow"; label: string }>;
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
