import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { uncertainOperation, type PendingOperation, api, type Bootstrap } from "./api";
import { RequestScope } from "./request-scope";
import { BrandMark } from "./BrandMark";
import { ComposerTools, ContextMeter, ModelControl, PermissionControl } from "./ComposerControls";
import { useProjectTrust } from "./ProjectTrust";
import { ApprovalPanel, FullAccessDialog, SettingsDialog, WorkspaceDialog } from "./Dialogs";
import { Icon } from "./icons";
import { applyHostEvent, fromSnapshot, type Projection } from "./projection";
import { Timeline } from "./Timeline";
import { RunOverview } from "./RunOverview";
import { Trajectory } from "./Trajectory";
import { WorkspacePanel } from "./WorkspacePanel";
import { ComposerAttachments, ComposerReferences, type AttachmentRef } from "./ComposerAttachments";
import { AutomationPanel } from "./AutomationPanel";
import { OrchestrationPanel } from "./OrchestrationPanel";
import { PluginPanel } from "./PluginPanel";
import type { PluginSlot } from "./PluginSlots";
import type { AgentPresetSummary, ContextStatus, HostEvent, ModelEntry, PolicyStatus, RuntimeStatus, SessionSnapshot, SessionSummary, SubagentStatus, Workspace } from "./types";

type Theme = "dark" | "light" | "system";
type ConversationView = "chat" | "trajectory";
type CommandResult = { output?: unknown; error?: string; ui?: string };
type AgentPresetId = string;

function phaseLabel(phase: string) {
  return ({ idle: "就绪", model: "模型响应", tool: "执行工具", retry: "正在重试", compacting: "整理上下文" } as Record<string, string>)[phase] || phase;
}

function resolvedTheme(theme: Theme): "dark" | "light" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function commandOutputNotice(output: unknown): string {
  if (typeof output === "string") return output.length > 420 ? `${output.slice(0, 419)}…` : output;
  if (Array.isArray(output)) {
    const names = output.map((entry) => entry && typeof entry === "object" && "name" in entry
      ? String((entry as { name: unknown }).name) : "").filter(Boolean);
    if (names.length) return `可用命令：${names.slice(0, 12).map((name) => `/${name}`).join("、")}${names.length > 12 ? ` 等 ${names.length} 个` : ""}`;
  }
  const serialized = JSON.stringify(output);
  return serialized.length > 420 ? `${serialized.slice(0, 419)}…` : serialized;
}

export function matchingCommands(commands: RuntimeStatus["commands"] | undefined, composer: string) {
  if (!commands || !composer.startsWith("/") || /\s/.test(composer)) return [];
  return commands.filter((command) => `/${command.name}`.startsWith(composer)).slice(0, 7);
}

export function selectablePresets(presets: AgentPresetSummary[]): AgentPresetSummary[] {
  return presets.filter((preset) => !preset.broken).sort((left, right) =>
    (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name, "zh-CN"));
}

export function defaultPresetId(presets: AgentPresetSummary[]): string | null {
  return presets.find((preset) => preset.id === "standard")?.id || presets[0]?.id || null;
}

export function creatorDraftPresetId(presets: AgentPresetSummary[]): string | null {
  return presets.find((preset) => preset.id === "creator" && !preset.broken)?.id || null;
}

export function PresetSelector({ presets, value, onChange }: {
  presets: AgentPresetSummary[];
  value: AgentPresetId;
  onChange: (value: AgentPresetId) => void;
}) {
  const selected = presets.find((preset) => preset.id === value);
  const description = selected ? `${presetDescription(selected)}。会话创建后保持不变。` : undefined;
  return <select className="toolbar-select preset-select" aria-label="Agent 模式" aria-description={description}
    title={description} value={value} onChange={(event) => onChange(event.target.value as AgentPresetId)}>
    {presets.map((preset) => <option key={preset.id} value={preset.id} title={presetDescription(preset)}>{preset.name}</option>)}
  </select>;
}

function presetDescription(preset: AgentPresetSummary): string {
  if (preset.description) return preset.description;
  if (preset.id === "creator") return "创建、检查并迭代 Agent preset 与运行时能力";
  if (preset.id === "standard") return "适合编码、分析与日常项目协作";
  return "使用此 Agent 配置开始新会话";
}

export function WorkspaceSelector({ workspaces, value, onChange, onAdd }: {
  workspaces: Workspace[];
  value: string;
  onChange: (value: string) => void;
  onAdd: () => void;
}) {
  return <div className="workspace-context-row">
    <label className="workspace-context-select">
      <Icon name="folder" />
      <select value={value} aria-label="选择工作区" onChange={(event) => onChange(event.target.value)}>
        <option value="" disabled>选择工作区</option>
        {workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}
      </select>
      <Icon name="chevron" />
    </label>
    <button type="button" className="workspace-context-add" onClick={onAdd}
      aria-label="添加新的工作区" title="添加工作区"><Icon name="plus" /></button>
  </div>;
}

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return <div className="brand-identity" aria-label="器，qì agent" title="器以载道">
    <BrandMark size={collapsed ? 24 : 23} />{!collapsed && <>
    <strong>qì</strong><span>agent</span>
  </>}</div>;
}

export function App() {
  const started = useRef(false);
  const timeline = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const trust = useProjectTrust();
  const stopInFlight = useRef(false);
  const [stopping, setStopping] = useState(false);
  const [stopRequestPending, setStopRequestPending] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [presets, setPresets] = useState<AgentPresetSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const activeSessionId = useRef<string | null>(null);
  activeSessionId.current = activeSession?.id || null;
  const [draftSession, setDraftSession] = useState<SessionSummary | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [subagents, setSubagents] = useState<SubagentStatus | null>(null);
  const [models, setModels] = useState<{ current: ModelEntry | null; providers: ModelEntry[] } | null>(null);
  const [policy, setPolicy] = useState<PolicyStatus | null>(null);
  const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [viewRevision, setViewRevision] = useState(0);
  const viewScope = useRef(new RequestScope());
  const navigationScope = useRef(new RequestScope());
  const modelScope = useRef(new RequestScope());
  const policyScope = useRef(new RequestScope());
  const captureOperation = () => {
    const view = viewScope.current.capture();
    const navigation = navigationScope.current.capture();
    return () => view() && navigation();
  };
  const [busy, setBusy] = useState(false);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [operationMissing, setOperationMissing] = useState(false);
  const openingCursor = useRef<string | undefined>(undefined);
  const [composer, setComposer] = useState("");
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const [workbench, setWorkbench] = useState<"files" | "automation" | "plugins" | "orchestration" | null>(null);
  const [pluginSlots, setPluginSlots] = useState<PluginSlot[]>([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [pendingThinking, setPendingThinking] = useState<string | null>(null);
  const [pendingPolicy, setPendingPolicy] = useState<PolicyStatus["mode"] | null>(null);
  const [pendingPreset, setPendingPreset] = useState<AgentPresetId>("standard");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    (localStorage.getItem("qi-agent.sidebar") || localStorage.getItem("dao.sidebar")) === "collapsed");
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [fullAccessDialogOpen, setFullAccessDialogOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"recent" | "name">("recent");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<string | null>(null);
  const [conversationView, setConversationView] = useState<ConversationView>("chat");
  const [theme, setTheme] = useState<Theme>(() =>
    ((localStorage.getItem("qi-agent.theme") || localStorage.getItem("dao.theme")) as Theme | null)
      || "system");
  const [resolving, setResolving] = useState(false);
  const approvalInFlight = useRef<string | null>(null);
  const [approvalError, setApprovalError] = useState<{ key: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { setAttachments([]); setUploading(false); setWorkbench(null); }, [workspaceId, activeSession?.id]);
  useEffect(() => {
    let active = true; setPluginSlots([]);
    if (activeSession) void api.rpc<{ slots: PluginSlot[] }>(activeSession.id, "plugins.ui-slots")
      .then(result => { if (active && Array.isArray(result.slots)) setPluginSlots(result.slots); }).catch(() => undefined);
    return () => { active = false; };
  }, [activeSession?.id, workbench]);

  const allSessions = useMemo(() => bootstrap?.catalogs
    .find((catalog) => catalog.workspaceId === workspaceId)?.sessions || [], [bootstrap, workspaceId]);
  const sessions = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const filtered = needle ? allSessions.filter((session) =>
      `${session.name || ""} ${session.label || ""}`.toLocaleLowerCase().includes(needle)) : allSessions;
    return [...filtered].sort(sortBy === "name"
      ? (a, b) => String(a.name).localeCompare(String(b.name), "zh-CN")
      : (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }, [allSessions, search, sortBy]);
  const runSummary = useMemo(() => {
    const durationMs = projection?.summary.durationMs || 0;
    const timing = durationMs > 0 ? `工具累计耗时 ${(durationMs / 1_000).toFixed(1)}s · ` : "";
    return `${timing}${projection?.events.length || 0} 条轨迹`;
  }, [projection?.summary, projection?.events.length]);

  const flashNotice = useCallback((message: string, timeout = 4_000) => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => {
      setNotice(null); noticeTimer.current = null;
    }, timeout);
  }, []);

  const showError = useCallback((error: unknown) => {
    if (uncertainOperation(error) && activeSessionId.current) {
      setPendingOperation(api.pendingOperation(activeSessionId.current));
      setOperationMissing(false);
    }
    flashNotice(error instanceof Error ? error.message : "操作失败", 5_000);
  }, [flashNotice]);

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  useEffect(() => {
    const apply = () => document.body.dataset.theme = resolvedTheme(theme);
    apply();
    localStorage.setItem("qi-agent.theme", theme);
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [theme]);

  const loadRuntime = useCallback(async (id: string) => {
    const current = viewScope.current.capture();
    const policyCurrent = policyScope.current.capture();
    const fallbackPolicy: PolicyStatus = {
      // Workers that predate policy.status still use agent.edn's shipped
      // :allow default. Keep their composer truthful while they age out.
      mode: "allow",
      modes: [
        { id: "deny", label: "Read Only" },
        { id: "ask", label: "Workspace Write" },
        { id: "allow", label: "Full Access" },
      ],
    };
    const [runtimeStatus, subagentStatus, policyStatus] = await Promise.all([
      api.rpc<RuntimeStatus>(id, "runtime.status"),
      api.rpc<SubagentStatus>(id, "subagent.status"),
      api.rpc<PolicyStatus>(id, "policy.status").catch(() => fallbackPolicy),
    ]);
    if (!current() || activeSessionId.current !== id) return;
    setRuntime(runtimeStatus);
    setSubagents(subagentStatus);
    if (policyCurrent()) setPolicy(policyStatus);
  }, []);

  const acceptSnapshot = useCallback((snapshot: SessionSnapshot) => {
    setProjection(fromSnapshot(snapshot));
    setModels(snapshot.models);
    setPolicy(snapshot.policy || null);
    setContextStatus(snapshot.context || null);
    setPendingModel(snapshot.models?.current?.id || null);
    setPendingThinking(snapshot.models?.current?.["thinking-level"] || null);
    setPendingPolicy(snapshot.policy?.mode || null);
    trust.setStatus(snapshot.trust || null);
  }, []);

  const acceptOpen = useCallback((session: SessionSummary, snapshot: SessionSnapshot, eventCursor?: string) => {
    trust.reset(); stopInFlight.current = false; setStopping(false); setStopRequestPending(false); setStopError(null);
    openingCursor.current = eventCursor;
    setPendingOperation(api.pendingOperation(session.id));
    setOperationMissing(false);
    viewScope.current.advance();
    setViewRevision((revision) => revision + 1);
    setBusy(false); setResolving(false); setFullAccessDialogOpen(false);
    setRuntime(null); setSubagents(null);
    activeSessionId.current = session.id;
    setActiveSession(session);
    setDraftSession(null);
    setWorkspaceId(session.workspaceId);
    acceptSnapshot(snapshot);
    setMobileSidebar(false);
    setSessionMenu(null);
    setNotice(null);
    setConversationView("chat");
    const current = viewScope.current.capture();
    void loadRuntime(session.id).catch((error) => { if (current()) showError(error); });
  }, [acceptSnapshot, loadRuntime, showError]);

  const openSession = useCallback(async (session: SessionSummary) => {
    const current = navigationScope.current.advance();
    trust.reset();
    setBusy(true);
    try {
      const opened = await api.openSession(session.id);
      if (current()) acceptOpen(opened.session, opened.snapshot, opened.eventCursor);
    } catch (error) { if (current()) showError(error); }
    finally { if (current()) setBusy(false); }
  }, [acceptOpen, showError]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void Promise.all([api.bootstrap(), api.listPresets()]).then(([data, discovered]) => {
      const available = selectablePresets(discovered);
      const initialPreset = defaultPresetId(available);
      if (!initialPreset) throw new Error("没有可用的 Agent 模式");
      setBootstrap(data);
      setPresets(available);
      setPendingPreset(initialPreset);
      setWorkspaceId(data.activeWorkspaceId);
      const first = data.catalogs.find((entry) => entry.workspaceId === data.activeWorkspaceId)?.sessions[0];
      if (first) void openSession(first);
    }).catch(showError);
  }, [loadRuntime, openSession, showError]);

  useEffect(() => {
    if (!activeSession) { setConnected(false); return; }
    setConnected(false);
    let disposed = false;
    const view = viewScope.current.capture();
    const currentSession = () => !disposed && view() && activeSessionId.current === activeSession.id;
    const close = api.events(activeSession.id, (event: HostEvent) => {
      if (!currentSession()) return;
      setProjection((current) => current ? applyHostEvent(current, event) : current);
      if (event.durable && event.event === "session/name" && typeof event.data?.name === "string") {
        const name = String(event.data.name);
        setActiveSession((current) => current ? { ...current, name } : current);
        setBootstrap((current) => current ? { ...current, catalogs: current.catalogs.map((catalog) => ({
          ...catalog,
          sessions: catalog.sessions.map((session) => session.id === activeSession.id
            ? { ...session, name }
            : session),
        })) } : current);
      }
      if (event.event?.startsWith("subagent/")) {
        void api.rpc<SubagentStatus>(activeSession.id, "subagent.status")
          .then((status) => { if (currentSession()) setSubagents(status); }).catch(() => undefined);
      }
      if (event.durable && ["message", "context/snapshot", "session/compaction", "session/clear"]
        .includes(event.event || "")) {
        void api.rpc<ContextStatus>(activeSession.id, "context.status")
          .then((status) => { if (currentSession()) setContextStatus(status); }).catch(() => undefined);
      }
    }, (status) => { if (currentSession()) setConnected(status); }, (snapshot) => {
      if (currentSession() && snapshot.session_id === activeSession.id) acceptSnapshot(snapshot);
    }, (message) => { if (currentSession()) flashNotice(message, 12_000); }, openingCursor.current);
    return () => { disposed = true; close(); };
  }, [activeSession?.id, viewRevision, acceptSnapshot, flashNotice]);

  useEffect(() => {
    if (conversationView === "trajectory") timeline.current?.scrollTo({ top: 0 });
  }, [activeSession?.id, conversationView]);

  const refreshCatalog = useCallback(async (targetWorkspace = workspaceId) => {
    if (!targetWorkspace) return;
    const next = await api.listSessions(targetWorkspace);
    setBootstrap((current) => current ? { ...current, catalogs: current.catalogs.map((catalog) =>
      catalog.workspaceId === targetWorkspace ? { ...catalog, sessions: next } : catalog) } : current);
  }, [workspaceId]);

  const startNewSession = () => {
    trust.reset(); stopInFlight.current = false; setStopping(false); setStopRequestPending(false); setStopError(null);
    navigationScope.current.advance();
    const current = viewScope.current.advance();
    setBusy(false); setResolving(false); setFullAccessDialogOpen(false);
    setPendingModel(models?.current?.id || null);
    setPendingThinking(models?.current?.["thinking-level"] || null);
    setPendingPolicy(policy?.mode || null);
    setPendingPreset(defaultPresetId(presets) || "standard");
    activeSessionId.current = null;
    setPendingOperation(null); setOperationMissing(false);
    setActiveSession(null); setDraftSession(null); setProjection(null); setConnected(false); setSubagents(null); setContextStatus(null);
    setComposer(""); setAttachments([]); setWorkbench(null); setCommandIndex(0); setDetailsOpen(false); setMobileSidebar(false); setConversationView("chat");
    const modelCurrent = modelScope.current.capture();
    const policyCurrent = policyScope.current.capture();
    const source = activeSession;
    if (source) {
      void Promise.all([
        api.rpc<RuntimeStatus>(source.id, "runtime.status"),
        api.rpc<{ current: ModelEntry | null; providers: ModelEntry[] }>(source.id, "model.list"),
        api.rpc<PolicyStatus>(source.id, "policy.status"),
      ]).then(([nextRuntime, nextModels, nextPolicy]) => {
        if (!current()) return;
        setRuntime(nextRuntime);
        if (modelCurrent()) {
          setModels(nextModels);
          setPendingModel(nextModels.current?.id || null);
          setPendingThinking(nextModels.current?.["thinking-level"] || null);
        }
        if (policyCurrent()) { setPolicy(nextPolicy); setPendingPolicy(nextPolicy.mode); }
      }).catch((error) => { if (current()) showError(error); });
    }
  };

  const startCreatorDraft = () => {
    const creator = creatorDraftPresetId(presets);
    if (!creator) return;
    startNewSession();
    setPendingPreset(creator);
    setComposer("帮我创建一个自定义 Agent preset。请先加载 creating-agent-presets skill 并调用 preset_guide，再检查现有模式并从合适的基础模式复制。");
    requestAnimationFrame(() => composerInput.current?.focus());
  };

  const refreshSnapshot = async (id = activeSession?.id) => {
    if (!id) return;
    const current = viewScope.current.capture();
    const snapshot = await api.rpc<SessionSnapshot>(id, "session.snapshot");
    if (!current() || activeSessionId.current !== id) return;
    setProjection(fromSnapshot(snapshot));
    setContextStatus(snapshot.context || null);
  };

  const send = async (mode: "auto" | "steer" = "auto") => {
    if ((!composer.trim() && !attachments.length) || busy || uploading || stopping || !workspaceId || pendingOperation || projection?.interactions.length) return;
    let current = captureOperation();
    const message = composer.trim();
    const selectedAttachments = attachments;
    if (message.startsWith("/") && selectedAttachments.length) { flashNotice("命令不能携带附件，请先发送附件或移除附件。"); return; }
    setBusy(true);
    let session = activeSession || draftSession;
    let messageSubmitted = false;
    try {
      // Freeze selected source text before journaling a mutation, so retries use identical content.
      const expanded = /@(file|session):"/.test(message) ? await api.resolveReferences(workspaceId, message) : message;
      if (!current()) return;
      const content = selectedAttachments.length ? [...(expanded ? [{ type: "text", text: expanded }] : []), ...selectedAttachments] : expanded;
      if (!activeSession && session && session.presetId !== pendingPreset) {
        await api.archiveSession(session.id);
        if (!current()) return;
        const created = await api.createSession(workspaceId, undefined, pendingPreset);
        if (!current()) return;
        session = created.session;
        setDraftSession(created.session);
        setModels(created.snapshot.models);
        setPolicy(created.snapshot.policy || null);
      }
      if (!session) {
        const created = await api.createSession(workspaceId, undefined, pendingPreset);
        if (!current()) return;
        session = created.session;
        setDraftSession(created.session);
      }
      // Check the worker's effective store/profile, before commands or model work.
      if (!await trust.check(session.id, current) || !current()) return;
      if (!activeSession) {
        if (pendingModel) await api.rpc(session.id, "model.select", { provider: pendingModel });
        if (!current()) return;
        if (pendingThinking) await api.rpc(session.id, "model.thinking.select", { level: pendingThinking });
        if (!current()) return;
        if (pendingPolicy) await api.rpc(session.id, "policy.select", { mode: pendingPolicy });
        if (!current()) return;
        const snapshot = await api.rpc<SessionSnapshot>(session.id, "session.snapshot");
        if (!current()) return;
        acceptOpen(session, snapshot);
        current = captureOperation();
        setBusy(true);
        await refreshCatalog(workspaceId);
      }
      if (!current()) return;
      setComposer(""); setAttachments([]);
      messageSubmitted = true;
      if (message.startsWith("/")) {
        const result = await api.rpc<CommandResult>(session.id,
          "command.execute", { command: message });
        if (!current()) return;
        if (result.error) throw new Error(result.error);
        if (result.ui === "model-selector" && result.output && typeof result.output === "object") {
          const output = result.output as { current?: ModelEntry | null; providers?: ModelEntry[] };
          if (Array.isArray(output.providers)) {
            setModels({ current: output.current || null, providers: output.providers });
            setPendingModel(output.current?.id || null);
            setPendingThinking(output.current?.["thinking-level"] || null);
          }
          flashNotice("请从模型菜单中选择本会话使用的模型");
        } else if (result.output != null) {
          flashNotice(commandOutputNotice(result.output));
        }
        await refreshSnapshot(session.id);
        const trustStatus = await api.rpc<import("./types").ProjectTrust>(session.id, "trust.status");
        if (current()) trust.setStatus(trustStatus);
      } else if (mode === "steer") {
        await api.rpc(session.id, "turn.steer", { message: content });
      } else if (projection?.state.phase && projection.state.phase !== "idle") {
        await api.rpc(session.id, "turn.follow-up", { message: content });
      } else {
        await api.rpc(session.id, "turn.submit", { message: content });
      }
    } catch (error) { if (current()) {
      if (!messageSubmitted || !uncertainOperation(error)) { setComposer(message); setAttachments(selectedAttachments); }
      if (uncertainOperation(error) && session) {
        setPendingOperation(api.pendingOperation(session.id));
        setOperationMissing(false);
      }
      showError(error);
    } }
    finally { if (current()) setBusy(false); }
  };

  const reconcileOperation = async (retry = false) => {
    if (!pendingOperation || busy) return;
    const operation = pendingOperation;
    const current = captureOperation();
    setBusy(true);
    try {
      if (retry) {
        await api.retryOperation(operation.sessionId);
        if (!current()) return;
        setPendingOperation(null); setOperationMissing(false);
        flashNotice("已核对并完成提交");
      } else {
        const result = await api.operationStatus(operation.sessionId);
        if (!current()) return;
        setOperationMissing(result.status === "not_found");
        if (result.status === "completed" || result.status === "failed") {
          setPendingOperation(null);
          if (result.status === "failed" && ["turn.submit", "turn.steer", "turn.follow-up"].includes(operation.method)) {
            const content = operation.params.message;
            const text = typeof content === "string" ? content : Array.isArray(content)
              ? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
            const files = Array.isArray(content) ? content.filter(block => block?.type === "attachment" && block.workspaceId === workspaceId).slice(0, 8) as AttachmentRef[] : [];
            setComposer(value => value || text); setAttachments(value => value.length ? value : files);
          }
          flashNotice(result.status === "completed" ? "已确认原操作完成，无需重复提交"
            : result.error?.message || "已确认原操作失败，请检查后再操作", 8_000);
        } else flashNotice(result.status === "pending" ? "仍在等待执行结果，请稍后再次核对"
          : "尚未找到接纳记录，可使用原提交编号重试", 8_000);
      }
      await refreshSnapshot(operation.sessionId);
    } catch (error) { if (current()) showError(error); }
    finally { if (current()) setBusy(false); }
  };

  const resolveApproval = async (decision: "allow" | "allow-session" | "deny") => {
    const current = captureOperation();
    const interaction = projection?.interactions[0];
    if (!interaction || !activeSession || resolving || stopInFlight.current) return;
    const key = `${activeSession.id}:${interaction.id}`;
    if (approvalInFlight.current === key) return;
    approvalInFlight.current = key;
    setResolving(true); setApprovalError(null);
    try {
      await api.rpc(activeSession.id, "interaction.resolve", { id: interaction.id, decision });
      if (!current()) return;
      setProjection((current) => current ? { ...current,
        interactions: current.interactions.filter((entry) => entry.id !== interaction.id) } : current);
    } catch (error) { if (current()) {
      setApprovalError({ key, message: error instanceof Error ? error.message : "确认失败，请重试" });
    } }
    finally {
      if (approvalInFlight.current === key) approvalInFlight.current = null;
      if (current()) setResolving(false);
    }
  };

  const stopRun = async () => {
    if (!activeSession || stopInFlight.current) return;
    const current = captureOperation();
    const id = activeSession.id;
    stopInFlight.current = true; setStopping(true); setStopRequestPending(true); setStopError(null);
    try {
      await api.rpc(id, "turn.abort");
      if (!current()) return;
      setStopRequestPending(false);
      // Keep the active phase until the runtime actually confirms it is idle.
      await refreshSnapshot(id);
    } catch (error) {
      if (current()) {
        stopInFlight.current = false; setStopping(false); setStopRequestPending(false);
        if (uncertainOperation(error)) {
          setPendingOperation(api.pendingOperation(id)); setOperationMissing(false);
        }
        setStopError(error instanceof Error ? error.message : "停止失败，请重试。");
        showError(error);
      }
    }
  };

  const renameSession = async (session = activeSession) => {
    const current = captureOperation();
    if (!session) return;
    const name = window.prompt("会话名称", session.name || "");
    if (!name?.trim()) return;
    try {
      await api.rpc(session.id, "session.rename", { name: name.trim() });
      if (current() && session.id === activeSessionId.current) setActiveSession((active) => active ? { ...active, name: name.trim() } : active);
      await refreshCatalog(session.workspaceId);
    } catch (error) { if (current()) showError(error); }
  };

  const forkSession = async (session = activeSession) => {
    const current = captureOperation();
    if (!session) return;
    setBusy(true);
    try {
      const forked = await api.forkSession(session.id, `${session.name || "未命名会话"} · 分支`);
      if (current()) acceptOpen(forked.session, forked.snapshot, forked.eventCursor);
      await refreshCatalog(session.workspaceId);
    } catch (error) { if (current()) showError(error); }
    finally { if (current()) setBusy(false); }
  };

  const archiveSession = async (session: SessionSummary) => {
    const current = captureOperation();
    if (!window.confirm(`归档会话“${session.name || "未命名会话"}”？正在运行的任务会停止，会话文件会移到工作区的归档目录。`)) return;
    try {
      await api.archiveSession(session.id);
      if (current() && activeSessionId.current === session.id) startNewSession();
      await refreshCatalog(session.workspaceId);
      if (current()) flashNotice("会话已归档");
    } catch (error) { if (current()) showError(error); }
  };

  const selectModel = async (provider: string) => {
    const viewCurrent = captureOperation();
    const selectionCurrent = modelScope.current.advance();
    const current = () => viewCurrent() && selectionCurrent();
    const local = models?.providers.find((entry) => entry.id === provider) || null;
    setPendingModel(provider);
    setPendingThinking(local?.["thinking-level"] || null);
    if (!activeSession && !draftSession) {
      if (local) setModels((current) => current ? { ...current, current: local } : current);
      return;
    }
    try {
      const selected = await api.rpc<ModelEntry>((activeSession || draftSession)!.id,
        "model.select", { provider });
      if (!current()) return;
      setModels((current) => current ? { ...current, current: selected } : current);
      setPendingThinking(selected["thinking-level"] || null);
      void api.rpc<ContextStatus>((activeSession || draftSession)!.id, "context.status")
        .then((status) => { if (current()) setContextStatus(status); }).catch(() => undefined);
      flashNotice(`已切换到 ${selected.model || provider}`);
    } catch (error) { if (current()) showError(error); }
  };

  const selectThinking = async (level: string) => {
    const viewCurrent = captureOperation();
    const selectionCurrent = modelScope.current.advance();
    const current = () => viewCurrent() && selectionCurrent();
    setPendingThinking(level);
    const applyLocal = (entry: ModelEntry) => ({ ...entry, "thinking-level": level });
    setModels((current) => current ? {
      current: current.current ? applyLocal(current.current) : null,
      providers: current.providers.map((entry) => entry.id === (pendingModel || current.current?.id)
        ? applyLocal(entry) : entry),
    } : current);
    if (!activeSession && !draftSession) return;
    try {
      const selected = await api.rpc<ModelEntry>((activeSession || draftSession)!.id,
        "model.thinking.select", { level });
      if (!current()) return;
      setModels((current) => current ? { ...current, current: selected,
        providers: current.providers.map((entry) => entry.id === selected.id ? selected : entry) } : current);
      flashNotice(`推力强度已设为 ${level}`);
    } catch (error) { if (current()) showError(error); }
  };

  const selectPolicy = async (mode: PolicyStatus["mode"]) => {
    const viewCurrent = captureOperation();
    const selectionCurrent = policyScope.current.advance();
    const current = () => viewCurrent() && selectionCurrent();
    setPendingPolicy(mode);
    if (!activeSession && !draftSession) {
      setPolicy((current) => current ? { ...current, mode } : current);
      return;
    }
    try {
      await api.rpc((activeSession || draftSession)!.id, "policy.select", { mode });
      if (current()) setPolicy((current) => current ? { ...current, mode } : current);
    } catch (error) { if (current()) showError(error); }
  };

  const requestPolicy = (mode: PolicyStatus["mode"]) => {
    if (mode === "allow" && (pendingPolicy || policy?.mode) !== "allow") {
      setFullAccessDialogOpen(true);
      return;
    }
    void selectPolicy(mode);
  };

  const addWorkspace = async (path: string) => {
    const workspace = await api.addWorkspace(path);
    const data = await api.bootstrap();
    setBootstrap(data); setWorkspaceId(workspace.id); startNewSession();
    setPendingPreset(pendingPreset);
    setWorkspaceDialogOpen(false);
    flashNotice(`已添加并切换到工作区“${workspace.name}”`);
    const current = captureOperation();
    setBusy(true);
    try {
      const created = await api.createSession(workspace.id, undefined, pendingPreset);
      if (!current()) return;
      setDraftSession(created.session);
      setModels(created.snapshot.models); setPolicy(created.snapshot.policy || null);
      await trust.check(created.session.id, current);
    } catch (error) { if (current()) showError(error); }
    finally { if (current()) setBusy(false); }
  };

  const removeWorkspace = async (workspace: Workspace) => {
    if (!window.confirm(`从 Web UI 移除工作区“${workspace.name}”？不会删除任何项目文件。`)) return;
    await api.removeWorkspace(workspace.id);
    const data = await api.bootstrap();
    setBootstrap(data);
    if (workspace.id === workspaceId) { setWorkspaceId(data.activeWorkspaceId); startNewSession(); }
  };

  const activeWorkspace = bootstrap?.workspaces.find((entry) => entry.id === workspaceId);
  const phase = projection?.state.phase || "idle";
  useEffect(() => {
    if (!stopRequestPending && phase === "idle" && !projection?.interactions.length) {
      stopInFlight.current = false; setStopping(false); setStopError(null);
    }
  }, [phase, projection?.interactions.length, stopRequestPending]);
  const commandSuggestions = matchingCommands(runtime?.commands, composer);
  const selectedModel = models?.providers.find((entry) => entry.id === pendingModel)
    || models?.current || null;
  const composerContext = contextStatus?.context_window ? contextStatus : (selectedModel?.["context-window"] ? {
    used_tokens: 0,
    context_window: selectedModel["context-window"],
    percent: 0,
    system_tokens: 0,
    tool_tokens: 0,
    message_tokens: 0,
  } : null);

  useEffect(() => setCommandIndex(0), [composer.split(/\s/, 1)[0], commandSuggestions.length]);

  useLayoutEffect(() => {
    const input = composerInput.current;
    if (!input) return;
    input.style.height = "0px";
    const nextHeight = Math.max(44, Math.min(input.scrollHeight, 180));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > 180 ? "auto" : "hidden";
  }, [activeSession?.id, composer]);

  const chooseCommand = (index = commandIndex) => {
    const command = commandSuggestions[index];
    if (!command) return;
    setComposer(`/${command.name} `);
    requestAnimationFrame(() => composerInput.current?.focus());
  };

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      localStorage.setItem("qi-agent.sidebar", current ? "expanded" : "collapsed");
      return !current;
    });
  };

  const workbenchRpc = useCallback((method: string, params: Record<string, unknown> = {}) => {
    const sessionId = activeSession?.id, current = viewScope.current.capture();
    if (!sessionId) return Promise.reject(new Error("请先开始一个会话"));
    return api.rpc(sessionId, method, params).catch(error => {
      if (current() && activeSessionId.current === sessionId) showError(error);
      throw error;
    });
  }, [activeSession?.id, showError]);

  const approvalNode = projection?.interactions[0] && <ApprovalPanel interaction={projection.interactions[0]} count={projection.interactions.length}
    resolving={resolving} onResolve={resolveApproval} onStop={() => void stopRun()} stopping={stopping} stopError={stopError}
    error={approvalError?.key === `${activeSession?.id}:${projection.interactions[0].id}` ? approvalError.message : null} />;

  const composerNode = <div className="composer-shell">
    {workspaceId && <ComposerReferences workspaceId={workspaceId} value={composer} onChange={setComposer}
      suggest={api.referenceSuggestions} disabled={busy || !!pendingOperation} />}
    {pendingOperation && <div className="provider-reload-notice" role="status">
      <p>上一项操作的结果尚未确认。核对完成前暂停新提交，以免重复执行。</p>
      <button type="button" className="button ghost" disabled={busy} onClick={() => void reconcileOperation()}>核对结果</button>
      {operationMissing && <button type="button" className="button ghost" disabled={busy}
        onClick={() => void reconcileOperation(true)}>使用原编号重试</button>}
    </div>}
    {commandSuggestions.length > 0 && <div id="command-suggestions" className="command-menu" role="listbox" aria-label="命令建议">
      <div className="command-menu-title">命令</div>
      {commandSuggestions.map((command, index) => <button type="button" role="option" key={command.name}
        aria-selected={index === commandIndex} className={index === commandIndex ? "selected" : ""}
        onMouseEnter={() => setCommandIndex(index)} onClick={() => chooseCommand(index)}>
        <code>{command.name}</code><span>{command.description}</span></button>)}
    </div>}
    <div className={`composer ${phase !== "idle" ? "is-active" : ""} ${composer.trim() ? "has-content" : ""} ${projection?.interactions.length ? "has-approval" : ""}`} aria-busy={busy}>
      {trust.status?.configured && trust.status.decision === "deny" && <div className="composer-trust" role="status">
        <Icon name="shield" /><span>项目受限 · 需要信任的命令已禁用</span>
        {trust.status.mutable !== false && <button type="button" disabled={busy} onClick={() => {
          const session = activeSession || draftSession;
          if (session) void trust.check(session.id, captureOperation(), true).catch(showError);
        }}>信任项目</button>}
      </div>}
      {!workbench && approvalNode}
      <ComposerAttachments key={`${workspaceId}:${activeSession?.id || "draft"}`} workspaceId={workspaceId || ""}
        inputRef={attachmentInput} items={attachments} onChange={setAttachments} upload={api.uploadAttachment}
        disabled={!workspaceId || busy || !!pendingOperation} onBusyChange={setUploading}>
      <textarea ref={composerInput} rows={1} value={composer} disabled={!workspaceId || busy} placeholder={workspaceId ? "描述目标、问题或想创建的能力…" : "选择一个工作区开始"}
        aria-controls={commandSuggestions.length ? "command-suggestions" : undefined}
        onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (commandSuggestions.length && event.key === "ArrowDown") {
            event.preventDefault(); setCommandIndex((value) => (value + 1) % commandSuggestions.length); return;
          }
          if (commandSuggestions.length && event.key === "ArrowUp") {
            event.preventDefault(); setCommandIndex((value) => (value - 1 + commandSuggestions.length) % commandSuggestions.length); return;
          }
          if (commandSuggestions.length && (event.key === "Tab" || event.key === "Enter")) {
            event.preventDefault(); chooseCommand(); return;
          }
          if (commandSuggestions.length && event.key === "Escape") {
            event.preventDefault(); setComposer(""); return;
          }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
        }} aria-label="给代理发送消息" />
      <div className="composer-footer">
        <div className="composer-left">
          <ComposerTools actions={[
            { label: "添加附件", icon: "plus", disabled: !workspaceId || busy || uploading || !!pendingOperation || attachments.length >= 8, run: () => attachmentInput.current?.click() },
            { label: "引用文件 / 会话", icon: "copy", disabled: !workspaceId || busy, run: () => { setComposer(value => `${value}${value ? " " : ""}@`); composerInput.current?.focus(); } },
            { label: "命令", icon: "command", disabled: !workspaceId || busy, run: () => { setComposer(value => value.startsWith("/") ? value : "/"); composerInput.current?.focus(); } },
            { label: "文件与变更", icon: "folder", disabled: !workspaceId, run: () => setWorkbench("files") },
            { label: "计划与协作", icon: "bot", disabled: !activeSession, run: () => setWorkbench("orchestration") },
            { label: "自动化", icon: "clock", disabled: !activeSession, run: () => setWorkbench("automation") },
            { label: "插件", icon: "settings", disabled: !activeSession, run: () => setWorkbench("plugins") },
          ]} />
          {policy && <PermissionControl policy={policy} onChange={requestPolicy} />}
          {!!models?.providers.length && <ModelControl models={models.providers}
            selectedId={pendingModel || models.current?.id || null} thinkingLevel={pendingThinking}
            onSelectModel={(provider) => void selectModel(provider)}
            onSelectThinking={(level) => void selectThinking(level)} />}
        </div>
        <div className="composer-right">
          {composerContext && <ContextMeter status={composerContext} />}
          {(phase !== "idle" || !!projection?.interactions.length || stopping) && activeSession ? <button type="button" className="send-button stop"
            disabled={stopping} aria-busy={stopping} onClick={() => void stopRun()} aria-label={stopping ? "正在停止" : "停止运行"}><Icon name="stop" /></button>
            : <button type="button" className={`send-button ${busy ? "loading" : ""}`} disabled={(!composer.trim() && !attachments.length) || busy || uploading || !workspaceId || !!pendingOperation}
              aria-busy={busy} onClick={() => void send()} aria-label={busy ? "正在发送" : "发送消息"}><Icon name="send" /></button>}
        </div>
      </div>
      </ComposerAttachments>
    </div>
    <div className={`composer-hint ${phase !== "idle" || stopping ? "has-run" : ""}`}><span>{stopping ? "请等待运行结束…" : projection?.interactions.length ? "先确认上方操作 · 可继续编辑草稿" : phase !== "idle" ? "Enter 排队发送 · Shift + Enter 换行" : "Enter 发送 · Shift + Enter 换行"}</span>
      {phase !== "idle" && !projection?.interactions.length && composer.trim() && <button type="button" className="steer-button" disabled={busy || uploading || stopping || !!pendingOperation} onClick={() => void send("steer")}>立即引导</button>}
    </div>
    {stopError && !projection?.interactions.length && <p className="composer-error" role="alert">{stopError} <button type="button" onClick={() => void stopRun()}>重试停止</button></p>}
  </div>;

  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${detailsOpen ? "details-open" : ""}`}>
    <aside className={`sidebar ${mobileSidebar ? "is-open" : ""}`}>
      <div className="sidebar-brand-row">
        <button type="button" className="brand-button" onClick={startNewSession} aria-label="新建会话"><Brand collapsed={sidebarCollapsed && !mobileSidebar} /></button>
        <button type="button" className="icon-button sidebar-toggle" onClick={mobileSidebar ? () => setMobileSidebar(false) : toggleSidebar}
          aria-label={mobileSidebar ? "收起导航" : sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}><Icon name="panel" /></button>
      </div>
      <button className="new-session" type="button" onClick={startNewSession} disabled={!workspaceId || busy}>
        <Icon name="plus" />{(!sidebarCollapsed || mobileSidebar) && <span>新会话</span>}
      </button>
      {(!sidebarCollapsed || mobileSidebar) && <>
        <div className="sidebar-workspace">
          <label className="workspace-select"><Icon name="folder" /><select value={workspaceId || ""} aria-label="工作区"
            onChange={(event) => { setWorkspaceId(event.target.value); startNewSession(); }}>
            {bootstrap?.workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></label>
          <button className="icon-button compact" type="button" onClick={() => setWorkspaceDialogOpen(true)} aria-label="添加工作区" title="添加工作区"><Icon name="plus" /></button>
        </div>
        <div className="workspace-heading"><span>会话</span><div>
          <button className={`icon-button compact ${searchOpen ? "active" : ""}`} type="button" onClick={() => setSearchOpen((value) => !value)} aria-label="搜索会话"><Icon name="search" /></button>
          <button className={`icon-button compact ${viewMenuOpen ? "active" : ""}`} type="button" onClick={() => setViewMenuOpen((value) => !value)} aria-label="视图选项"><Icon name="sliders" /></button>
        </div></div>
        {searchOpen && <input className="session-search" value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索会话…" aria-label="搜索会话" />}
        {viewMenuOpen && <div className="view-menu" role="menu">
          <button type="button" role="menuitem" className={sortBy === "recent" ? "active" : ""}
            onClick={() => { setSortBy("recent"); setViewMenuOpen(false); }}>最近更新</button>
          <button type="button" role="menuitem" className={sortBy === "name" ? "active" : ""}
            onClick={() => { setSortBy("name"); setViewMenuOpen(false); }}>按名称</button>
        </div>}
        <nav className="session-nav" aria-label="会话列表">
          {sessions.length ? sessions.map((session) => <div className={`session-row ${session.id === activeSession?.id ? "active" : ""}`} key={session.id}>
            <button type="button" className="session-link" onClick={() => void openSession(session)}>
              <span className="session-title">{session.name || "未命名会话"}</span>
              <span className="session-meta">{session.messageCount} 条消息 · {session.updatedAt ? new Date(session.updatedAt).toLocaleDateString() : "刚刚"}</span>
            </button>
            <button type="button" className="session-more" aria-label={`会话操作: ${session.name || "未命名会话"}`}
              onClick={() => setSessionMenu((current) => current === session.id ? null : session.id)}><Icon name="more" /></button>
            {sessionMenu === session.id && <div className="session-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setSessionMenu(null); void renameSession(session); }}><Icon name="edit" />重命名</button>
              <button type="button" role="menuitem" onClick={() => { setSessionMenu(null); void forkSession(session); }}><Icon name="branch" />创建分支</button>
              <button type="button" role="menuitem" onClick={() => { setSessionMenu(null); void archiveSession(session); }}><Icon name="archive" />归档</button>
            </div>}
          </div>) : <div className="empty-nav">{search ? "没有匹配的会话" : "暂无会话"}</div>}
        </nav>
      </>}
      <button className="sidebar-settings" type="button" onClick={() => setSettingsOpen(true)} aria-label="设置"><Icon name="settings" />{(!sidebarCollapsed || mobileSidebar) && <span>设置</span>}</button>
    </aside>
    {mobileSidebar && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileSidebar(false)} />}

    <main className="main-panel">
      {!activeSession ? <section className="new-session-view">
        <button className="mobile-nav-button" type="button" onClick={() => setMobileSidebar(true)} aria-label="打开导航"><Icon name="menu" /></button>
        <div className="new-session-center">
          <div className="welcome-copy">
            <h1>今天想完成什么？</h1>
            <p>描述目标，在项目中开始协作。</p>
          </div>
          <div className="draft-workbench">
            <div className="draft-context">
              <WorkspaceSelector workspaces={bootstrap?.workspaces || []} value={workspaceId || ""}
                onChange={id => { startNewSession(); setWorkspaceId(id); }} onAdd={() => setWorkspaceDialogOpen(true)} />
              <label className="draft-preset"><Icon name="bot" />
                <PresetSelector presets={presets} value={pendingPreset} onChange={setPendingPreset} /><Icon name="chevron" />
              </label>
            </div>
            {composerNode}
            <div className="starter-actions" aria-label="快捷开始">
              <button type="button" title="快速了解结构与风险" onClick={() => { setComposer("分析当前项目结构，指出最值得优先处理的问题，并给出执行建议。"); requestAnimationFrame(() => composerInput.current?.focus()); }}>
                <Icon name="search" /><span>分析项目</span>
              </button>
              <button type="button" title="检查测试与明显缺陷" onClick={() => { setComposer("检查当前项目中的失败测试和明显缺陷，定位根因并修复。"); requestAnimationFrame(() => composerInput.current?.focus()); }}>
                <Icon name="activity" /><span>定位问题</span>
              </button>
              {creatorDraftPresetId(presets) && <button type="button" className="creator-draft-button" title="用创造模式起草 Agent"
                onClick={startCreatorDraft}><Icon name="sparkles" /><span>创建 Agent</span></button>}
            </div>
          </div>
        </div>
      </section> : <section className="session-view">
        <header className="session-header">
          <button className="mobile-nav-button" type="button" onClick={() => setMobileSidebar(true)} aria-label="打开导航"><Icon name="menu" /></button>
          <div className="session-header-title"><span className={`connection-status ${connected ? "online" : ""}`} title={connected ? "实时连接" : "正在重连"}>
            <span className="connection-dot" />{connected ? "已连接" : "重连中"}</span>
            <button type="button" onClick={() => void renameSession()}>{activeSession.name || "未命名会话"}</button>
            <span>{presets.find((preset) => preset.id === activeSession.presetId)?.name
              || activeSession.presetId || "旧版默认模式"}</span></div>
          <div className="session-header-actions">
            {subagents?.jobs.length ? <span className="job-pill">{subagents.jobs.filter((job) => job.status === "running").length} 个后台任务</span> : null}
            <div className="view-tabs" role="tablist" aria-label="会话视图"><button type="button" role="tab" aria-selected={conversationView === "chat"}
              onClick={() => setConversationView("chat")}>对话</button><button type="button" role="tab" aria-selected={conversationView === "trajectory"}
                onClick={() => setConversationView("trajectory")}>轨迹</button></div>
            <button type="button" className={`header-action ${detailsOpen ? "active" : ""}`} aria-label="会话信息" title="会话信息"
              aria-expanded={detailsOpen} onClick={() => setDetailsOpen((value) => !value)}><Icon name="panel" /></button>
          </div>
        </header>
        <RunOverview phase={pendingOperation ? `${stopping ? "正在停止" : phaseLabel(phase)} · 操作结果待核对`
          : stopping ? "stopping" : phase}
          turns={projection?.summary.turns ?? 0} steps={projection?.summary.steps ?? 0}
          calls={projection?.summary.calls ?? 0} waitingCount={projection?.interactions.length ?? 0}
          context={contextStatus} />
        <div className={`timeline ${conversationView === "trajectory" ? "trajectory-mode" : ""}`} ref={timeline} tabIndex={0} aria-label="会话内容">
          {conversationView === "chat" && projection && <Timeline key={activeSession.id} projection={projection} scrollRef={timeline} pluginSlots={pluginSlots} />}
          {conversationView === "trajectory" && <Trajectory key={activeSession.id} events={projection?.events || []} />}
        </div>
        <div className="composer-wrap">{composerNode}<div className="session-run-summary">{runSummary}</div></div>
      </section>}
    </main>

    {detailsOpen && activeSession && <aside className="details-panel">
      <header><h2>会话日志</h2><button className="icon-button" type="button" onClick={() => setDetailsOpen(false)} aria-label="关闭详情"><Icon name="x" /></button></header>
      <section><h3>会话</h3><dl><div><dt>工作区</dt><dd>{activeWorkspace?.name}</dd></div><div><dt>连接</dt><dd>{connected ? "实时" : "重连中"}</dd></div>
        <div><dt>状态</dt><dd>{phaseLabel(phase)}</dd></div><div><dt>事件</dt><dd>{projection?.events.length || 0}</dd></div></dl></section>
      <section><h3>子代理</h3>{subagents?.jobs.length ? subagents.jobs.map((job) => <div className="detail-job" key={job.id}>
        <strong>{job.label}</strong><span>{job.provider} · {job.status}</span></div>) : <p>暂无子代理任务</p>}</section>
      <section><h3>能力</h3><div className="detail-metrics"><span><strong>{runtime?.tools.length ?? "—"}</strong>工具</span>
        <span><strong>{runtime?.plugins.length ?? "—"}</strong>插件</span></div></section>
    </aside>}

    {workbench && workspaceId && <section className="workbench-drawer" aria-label="工作台" onKeyDown={event => { if (event.key === "Escape") setWorkbench(null); }}>
      <div className="workbench-content">{workbench === "files" ? <WorkspacePanel workspaceId={workspaceId} sessionId={activeSession?.id} api={api.workspaceFiles}
        onClose={() => setWorkbench(null)} onReference={reference => { setComposer(value => `${value}${value ? " " : ""}${reference} `); setWorkbench(null); composerInput.current?.focus(); }} />
        : <><header className="workbench-heading"><strong>{workbench === "automation" ? "自动化" : workbench === "plugins" ? "插件" : "计划与协作"}</strong>
          <button type="button" onClick={() => setWorkbench(null)} aria-label="关闭工作台">×</button></header>
          {activeSession && workbench === "automation" && <AutomationPanel agentId={activeSession.id} readOnly={policy?.mode === "deny"}
            rpc={workbenchRpc} />}
          {activeSession && workbench === "plugins" && <PluginPanel readOnly={policy?.mode === "deny"}
            rpc={workbenchRpc} />}
          {activeSession && workbench === "orchestration" && <OrchestrationPanel sessionId={activeSession.id} onError={showError} />}</>}
      </div>
      {approvalNode && <div className="workbench-approval">{approvalNode}</div>}
    </section>}

    {trust.dialog}
    {fullAccessDialogOpen && <FullAccessDialog onClose={() => setFullAccessDialogOpen(false)}
      onConfirm={() => { setFullAccessDialogOpen(false); void selectPolicy("allow"); }} />}
    {settingsOpen && <SettingsDialog workspaces={bootstrap?.workspaces || []} runtime={runtime}
      theme={theme} onThemeChange={setTheme} onClose={() => setSettingsOpen(false)}
      onProvidersChanged={async () => {
        const current = captureOperation();
        const modelCurrent = modelScope.current.capture();
        const source = activeSession || draftSession;
        if (!source) return;
        const next = await api.rpc<{ current: ModelEntry | null; providers: ModelEntry[] }>(source.id, "model.list");
        if (!current() || !modelCurrent()) return;
        setModels(next);
        if (!next.providers.some((entry) => entry.id === pendingModel)) {
          setPendingModel(next.current?.id || null);
          setPendingThinking(next.current?.["thinking-level"] || null);
        }
      }}
      onAddWorkspace={() => { setSettingsOpen(false); setWorkspaceDialogOpen(true); }} onRemoveWorkspace={removeWorkspace} />}
    {workspaceDialogOpen && <WorkspaceDialog initialPath={activeWorkspace?.path} onClose={() => setWorkspaceDialogOpen(false)} onSelect={addWorkspace} />}
    {notice && <div className="toast" role="status">{notice}</div>}
  </div>;
}
