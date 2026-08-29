import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, type Bootstrap } from "./api";
import { BrandMark } from "./BrandMark";
import { ContextMeter, ModelControl, PermissionControl } from "./ComposerControls";
import { ApprovalDialog, FullAccessDialog, SettingsDialog, WorkspaceDialog } from "./Dialogs";
import { Icon } from "./icons";
import { applyHostEvent, fromSnapshot, type Projection } from "./projection";
import { Timeline } from "./Timeline";
import { Trajectory } from "./Trajectory";
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
  return <select className="toolbar-select preset-select" aria-label="Agent 模式" value={value}
    onChange={(event) => onChange(event.target.value as AgentPresetId)}>
    {presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
  </select>;
}

function presetDescription(preset: AgentPresetSummary): string {
  if (preset.description) return preset.description;
  if (preset.id === "creator") return "创建、检查并迭代 Agent preset 与运行时能力";
  if (preset.id === "standard") return "适合编码、分析与日常项目协作";
  return "使用此 Agent 配置开始新会话";
}

export function PresetCards({ presets, value, onChange }: {
  presets: AgentPresetSummary[];
  value: AgentPresetId;
  onChange: (value: AgentPresetId) => void;
}) {
  return <div className="preset-cards" role="radiogroup" aria-label="选择 Agent 模式">
    {presets.map((preset) => {
      const selected = value === preset.id;
      return <button type="button" role="radio" aria-checked={selected} key={preset.id}
        className={`preset-card ${selected ? "selected" : ""}`} onClick={() => onChange(preset.id)}>
        <span className="preset-card-icon"><Icon name={preset.id === "creator" ? "sparkles" : "bot"} /></span>
        <span className="preset-card-copy"><strong>{preset.name}</strong><small>{presetDescription(preset)}</small></span>
        <span className="preset-card-check"><Icon name="check" /></span>
      </button>;
    })}
  </div>;
}

export function WorkspaceSelector({ workspaces, value, onChange, onAdd }: {
  workspaces: Workspace[];
  value: string;
  onChange: (value: string) => void;
  onAdd: () => void;
}) {
  return <div className="new-session-context">
    <div className="workspace-context-field">
      <span className="workspace-context-label">工作区</span>
      <div className="workspace-context-row">
        <label className="workspace-context-select">
          <Icon name="folder" />
          <select value={value} aria-label="选择工作区" onChange={(event) => onChange(event.target.value)}>
            <option value="" disabled>选择工作区</option>
            {workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}
          </select>
          <Icon name="chevron" />
        </label>
        <button type="button" className="workspace-context-add" onClick={onAdd}
          aria-label="添加新的工作区"><Icon name="plus" /><span>添加工作区</span></button>
      </div>
    </div>
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
  const noticeTimer = useRef<number | null>(null);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [presets, setPresets] = useState<AgentPresetSummary[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [draftSession, setDraftSession] = useState<SessionSummary | null>(null);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [subagents, setSubagents] = useState<SubagentStatus | null>(null);
  const [models, setModels] = useState<{ current: ModelEntry | null; providers: ModelEntry[] } | null>(null);
  const [policy, setPolicy] = useState<PolicyStatus | null>(null);
  const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [composer, setComposer] = useState("");
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
  const [notice, setNotice] = useState<string | null>(null);

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
    const events = projection?.events || [];
    const turns = events.filter((event) => event.type === "message"
      && (event.data.message as { role?: string } | undefined)?.role === "user").length;
    const steps = events.filter((event) => event.type === "step/start").length;
    const calls = events.filter((event) => event.type === "tool/call").length;
    const durationMs = events.reduce((total, event) => {
      if (event.type !== "tool/result") return total;
      const value = event.data["duration-ms"] ?? event.data.duration_ms;
      return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
    }, 0);
    const timing = durationMs > 0 ? ` · 工具调用 ${(durationMs / 1_000).toFixed(1)}s` : "";
    return `${turns} 轮 · ${steps} 步 | ${calls} 次工具调用${timing} | ${events.length} 条轨迹`;
  }, [projection?.events]);

  const flashNotice = useCallback((message: string, timeout = 4_000) => {
    setNotice(message);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => {
      setNotice(null); noticeTimer.current = null;
    }, timeout);
  }, []);

  const showError = useCallback((error: unknown) => {
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
    setRuntime(runtimeStatus);
    setSubagents(subagentStatus);
    setPolicy(policyStatus);
  }, []);

  const acceptOpen = useCallback((session: SessionSummary, snapshot: SessionSnapshot) => {
    setActiveSession(session);
    setDraftSession(null);
    setWorkspaceId(session.workspaceId);
    setProjection(fromSnapshot(snapshot));
    setModels(snapshot.models);
    setPolicy(snapshot.policy || null);
    setContextStatus(snapshot.context || null);
    setPendingModel(snapshot.models?.current?.id || null);
    setPendingThinking(snapshot.models?.current?.["thinking-level"] || null);
    setPendingPolicy(snapshot.policy?.mode || null);
    setMobileSidebar(false);
    setSessionMenu(null);
    setNotice(null);
    setConversationView("chat");
    void loadRuntime(session.id).catch(showError);
  }, [loadRuntime, showError]);

  const openSession = useCallback(async (session: SessionSummary) => {
    setBusy(true);
    try { const opened = await api.openSession(session.id); acceptOpen(opened.session, opened.snapshot); }
    catch (error) { showError(error); }
    finally { setBusy(false); }
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
    return api.events(activeSession.id, (event: HostEvent) => {
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
        void api.rpc<SubagentStatus>(activeSession.id, "subagent.status").then(setSubagents).catch(() => undefined);
      }
      if (event.durable && ["message", "context/snapshot", "session/compaction", "session/clear"]
        .includes(event.event || "")) {
        void api.rpc<ContextStatus>(activeSession.id, "context.status").then(setContextStatus).catch(() => undefined);
      }
    }, setConnected);
  }, [activeSession?.id]);

  useEffect(() => {
    if (conversationView !== "chat") return;
    const element = timeline.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [conversationView, projection?.events.length, projection?.state["partial-assistant"]]);

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
    setPendingModel(models?.current?.id || null);
    setPendingThinking(models?.current?.["thinking-level"] || null);
    setPendingPolicy(policy?.mode || null);
    setPendingPreset(defaultPresetId(presets) || "standard");
    setActiveSession(null); setDraftSession(null); setProjection(null); setConnected(false); setSubagents(null); setContextStatus(null);
    setComposer(""); setCommandIndex(0); setDetailsOpen(false); setMobileSidebar(false); setConversationView("chat");
    const source = activeSession;
    if (source) {
      void Promise.all([
        api.rpc<RuntimeStatus>(source.id, "runtime.status"),
        api.rpc<{ current: ModelEntry | null; providers: ModelEntry[] }>(source.id, "model.list"),
        api.rpc<PolicyStatus>(source.id, "policy.status"),
      ]).then(([nextRuntime, nextModels, nextPolicy]) => {
        setRuntime(nextRuntime); setModels(nextModels); setPolicy(nextPolicy);
        setPendingModel(nextModels.current?.id || null);
        setPendingThinking(nextModels.current?.["thinking-level"] || null);
        setPendingPolicy(nextPolicy.mode);
      }).catch(showError);
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
    const snapshot = await api.rpc<SessionSnapshot>(id, "session.snapshot");
    setProjection(fromSnapshot(snapshot));
    setContextStatus(snapshot.context || null);
  };

  const send = async (mode: "auto" | "steer" = "auto") => {
    if (!composer.trim() || busy || !workspaceId) return;
    const message = composer.trim();
    setComposer(""); setBusy(true);
    let session = activeSession || draftSession;
    try {
      if (!activeSession && session && session.presetId !== pendingPreset) {
        await api.archiveSession(session.id);
        const created = await api.createSession(workspaceId, undefined, pendingPreset);
        session = created.session;
        setDraftSession(created.session);
        setModels(created.snapshot.models);
        setPolicy(created.snapshot.policy || null);
      }
      if (!session) {
        const created = await api.createSession(workspaceId, undefined, pendingPreset);
        session = created.session;
      }
      if (!activeSession) {
        if (pendingModel) await api.rpc(session.id, "model.select", { provider: pendingModel });
        if (pendingThinking) await api.rpc(session.id, "model.thinking.select", { level: pendingThinking });
        if (pendingPolicy) await api.rpc(session.id, "policy.select", { mode: pendingPolicy });
        const snapshot = await api.rpc<SessionSnapshot>(session.id, "session.snapshot");
        acceptOpen(session, snapshot);
        await refreshCatalog(workspaceId);
      }
      if (message.startsWith("/")) {
        const result = await api.rpc<CommandResult>(session.id,
          "command.execute", { command: message });
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
      } else if (mode === "steer") {
        await api.rpc(session.id, "turn.steer", { message });
      } else if (projection?.state.phase && projection.state.phase !== "idle") {
        await api.rpc(session.id, "turn.follow-up", { message });
      } else {
        await api.rpc(session.id, "turn.submit", { message });
      }
    } catch (error) { setComposer(message); showError(error); }
    finally { setBusy(false); }
  };

  const resolveApproval = async (decision: "allow" | "allow-session" | "deny") => {
    const interaction = projection?.interactions[0];
    if (!interaction || !activeSession) return;
    setResolving(true);
    try {
      await api.rpc(activeSession.id, "interaction.resolve", { id: interaction.id, decision });
      setProjection((current) => current ? { ...current,
        interactions: current.interactions.filter((entry) => entry.id !== interaction.id) } : current);
    } catch (error) { showError(error); }
    finally { setResolving(false); }
  };

  const renameSession = async (session = activeSession) => {
    if (!session) return;
    const name = window.prompt("会话名称", session.name || "");
    if (!name?.trim()) return;
    try {
      await api.rpc(session.id, "session.rename", { name: name.trim() });
      if (session.id === activeSession?.id) setActiveSession({ ...activeSession, name: name.trim() });
      await refreshCatalog(session.workspaceId);
    } catch (error) { showError(error); }
  };

  const forkSession = async (session = activeSession) => {
    if (!session) return;
    setBusy(true);
    try {
      const forked = await api.forkSession(session.id, `${session.name || "未命名会话"} · 分支`);
      acceptOpen(forked.session, forked.snapshot);
      await refreshCatalog(session.workspaceId);
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  };

  const archiveSession = async (session: SessionSummary) => {
    if (!window.confirm(`归档会话“${session.name || "未命名会话"}”？会话文件会移到工作区的归档目录。`)) return;
    try {
      await api.archiveSession(session.id);
      if (activeSession?.id === session.id) startNewSession();
      await refreshCatalog(session.workspaceId);
      flashNotice("会话已归档");
    } catch (error) { showError(error); }
  };

  const selectModel = async (provider: string) => {
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
      setModels((current) => current ? { ...current, current: selected } : current);
      setPendingThinking(selected["thinking-level"] || null);
      void api.rpc<ContextStatus>((activeSession || draftSession)!.id, "context.status")
        .then(setContextStatus).catch(() => undefined);
      flashNotice(`已切换到 ${selected.model || provider}`);
    } catch (error) { showError(error); }
  };

  const selectThinking = async (level: string) => {
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
      setModels((current) => current ? { ...current, current: selected,
        providers: current.providers.map((entry) => entry.id === selected.id ? selected : entry) } : current);
      flashNotice(`推力强度已设为 ${level}`);
    } catch (error) { showError(error); }
  };

  const selectPolicy = async (mode: PolicyStatus["mode"]) => {
    setPendingPolicy(mode);
    if (!activeSession && !draftSession) {
      setPolicy((current) => current ? { ...current, mode } : current);
      return;
    }
    try {
      await api.rpc((activeSession || draftSession)!.id, "policy.select", { mode });
      setPolicy((current) => current ? { ...current, mode } : current);
    } catch (error) { showError(error); }
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
    flashNotice(`已添加并切换到工作区“${workspace.name}”`);
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

  const composerNode = <div className="composer-shell">
    {commandSuggestions.length > 0 && <div id="command-suggestions" className="command-menu" role="listbox" aria-label="命令建议">
      <div className="command-menu-title">命令</div>
      {commandSuggestions.map((command, index) => <button type="button" role="option" key={command.name}
        aria-selected={index === commandIndex} className={index === commandIndex ? "selected" : ""}
        onMouseEnter={() => setCommandIndex(index)} onClick={() => chooseCommand(index)}>
        <code>{command.name}</code><span>{command.description}</span></button>)}
    </div>}
    <div className={`composer ${phase !== "idle" ? "is-active" : ""} ${composer.trim() ? "has-content" : ""}`} aria-busy={busy}>
      <textarea ref={composerInput} rows={1} value={composer} disabled={!workspaceId} placeholder={workspaceId ? "描述目标、问题或想创建的能力…" : "选择一个工作区开始"}
        aria-controls={commandSuggestions.length ? "command-suggestions" : undefined}
        onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => {
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
          <button type="button" className="toolbar-button command-button" aria-label="命令"
            onClick={() => { setComposer((value) => value.startsWith("/") ? value : "/"); requestAnimationFrame(() => composerInput.current?.focus()); }}><Icon name="plus" /></button>
          {policy && <PermissionControl policy={policy} onChange={requestPolicy} />}
          {phase !== "idle" && <span className="phase-copy">{phaseLabel(phase)} · 新消息将排队</span>}
        </div>
        <div className="composer-right">
          {!!models?.providers.length && <ModelControl models={models.providers}
            selectedId={pendingModel || models.current?.id || null} thinkingLevel={pendingThinking}
            onSelectModel={(provider) => void selectModel(provider)}
            onSelectThinking={(level) => void selectThinking(level)} />}
          {composerContext && <ContextMeter status={composerContext} />}
          {phase !== "idle" && composer.trim() && <button type="button" className="steer-button" onClick={() => void send("steer")}>立即引导</button>}
          {phase !== "idle" && activeSession ? <button type="button" className="send-button stop"
            onClick={() => void api.rpc(activeSession.id, "turn.abort")} aria-label="停止运行"><Icon name="stop" /></button>
            : <button type="button" className={`send-button ${busy ? "loading" : ""}`} disabled={!composer.trim() || busy || !workspaceId}
              aria-busy={busy} onClick={() => void send()} aria-label={busy ? "正在发送" : "发送消息"}><Icon name="send" /></button>}
        </div>
      </div>
    </div>
    <div className="composer-hint"><span>Enter 发送 · Shift + Enter 换行 · / 使用命令</span></div>
  </div>;

  return <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${detailsOpen ? "details-open" : ""}`}>
    <aside className={`sidebar ${mobileSidebar ? "is-open" : ""}`}>
      <div className="sidebar-brand-row">
        <button type="button" className="brand-button" onClick={startNewSession} aria-label="新建会话"><Brand collapsed={sidebarCollapsed} /></button>
        <button type="button" className="icon-button sidebar-toggle" onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}><Icon name="panel" /></button>
      </div>
      <button className="new-session" type="button" onClick={startNewSession} disabled={!workspaceId || busy}>
        <Icon name="plus" />{!sidebarCollapsed && <span>新会话</span>}
      </button>
      {!sidebarCollapsed && <>
        <div className="workspace-heading"><span>工作区</span><div>
          <button className={`icon-button compact ${searchOpen ? "active" : ""}`} type="button" onClick={() => setSearchOpen((value) => !value)} aria-label="搜索会话"><Icon name="search" /></button>
          <button className={`icon-button compact ${viewMenuOpen ? "active" : ""}`} type="button" onClick={() => setViewMenuOpen((value) => !value)} aria-label="视图选项"><Icon name="sliders" /></button>
          <button className="icon-button compact" type="button" onClick={() => setWorkspaceDialogOpen(true)} aria-label="添加工作区"><Icon name="folder" /></button>
        </div></div>
        {searchOpen && <input className="session-search" value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索会话…" aria-label="搜索会话" />}
        {viewMenuOpen && <div className="view-menu" role="menu">
          <button type="button" role="menuitem" className={sortBy === "recent" ? "active" : ""}
            onClick={() => { setSortBy("recent"); setViewMenuOpen(false); }}>最近更新</button>
          <button type="button" role="menuitem" className={sortBy === "name" ? "active" : ""}
            onClick={() => { setSortBy("name"); setViewMenuOpen(false); }}>按名称</button>
        </div>}
        <label className="workspace-select"><select value={workspaceId || ""} aria-label="工作区"
          onChange={(event) => { setWorkspaceId(event.target.value); startNewSession(); }}>
          {bootstrap?.workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></label>
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
      <button className="sidebar-settings" type="button" onClick={() => setSettingsOpen(true)} aria-label="设置"><Icon name="settings" />{!sidebarCollapsed && <span>设置</span>}</button>
    </aside>
    {mobileSidebar && <button className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileSidebar(false)} />}

    <main className="main-panel">
      {!activeSession ? <section className="new-session-view">
        <button className="mobile-nav-button" type="button" onClick={() => setMobileSidebar(true)} aria-label="打开导航"><Icon name="menu" /></button>
        <div className="new-session-center">
          <div className="welcome-copy">
            <div className="welcome-eyebrow"><BrandMark size={24} /><span>器 · qì agent</span></div>
            <h1>今天想完成什么？</h1>
            <p>选择工作区与 Agent 模式，然后描述目标。qì agent 会在项目上下文中持续执行并汇报进展。</p>
          </div>
          <WorkspaceSelector workspaces={bootstrap?.workspaces || []} value={workspaceId || ""}
            onChange={setWorkspaceId} onAdd={() => setWorkspaceDialogOpen(true)} />
          <div className="mode-heading"><span>Agent 模式</span><small>会话创建后保持不变</small></div>
          <PresetCards presets={presets} value={pendingPreset} onChange={setPendingPreset} />
          {composerNode}
          <div className="starter-actions" aria-label="快捷开始">
            <button type="button" onClick={() => { setComposer("分析当前项目结构，指出最值得优先处理的问题，并给出执行建议。"); requestAnimationFrame(() => composerInput.current?.focus()); }}>
              <Icon name="search" /><span><strong>分析项目</strong><small>快速了解结构与风险</small></span>
            </button>
            <button type="button" onClick={() => { setComposer("检查当前项目中的失败测试和明显缺陷，定位根因并修复。"); requestAnimationFrame(() => composerInput.current?.focus()); }}>
              <Icon name="activity" /><span><strong>定位问题</strong><small>检查测试与明显缺陷</small></span>
            </button>
            {creatorDraftPresetId(presets) && <button type="button" className="creator-draft-button"
              onClick={startCreatorDraft}><Icon name="sparkles" /><span><strong>创建 Agent</strong><small>用创造模式起草 preset</small></span></button>}
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
            <button type="button" className={`header-action ${detailsOpen ? "active" : ""}`} onClick={() => setDetailsOpen((value) => !value)}>
              会话信息<Icon name="chevron" /></button>
          </div>
        </header>
        <div className="view-tabs" role="tablist"><button type="button" role="tab" aria-selected={conversationView === "chat"}
          onClick={() => setConversationView("chat")}>对话</button><button type="button" role="tab" aria-selected={conversationView === "trajectory"}
            onClick={() => setConversationView("trajectory")}>轨迹</button></div>
        <div className={`timeline ${conversationView === "trajectory" ? "trajectory-mode" : ""}`} ref={timeline} aria-live="polite">
          {conversationView === "chat" && projection && <Timeline projection={projection} />}
          {conversationView === "trajectory" && <Trajectory events={projection?.events || []} />}
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

    {projection?.interactions[0] && <ApprovalDialog interaction={projection.interactions[0]}
      resolving={resolving} onResolve={resolveApproval} />}
    {fullAccessDialogOpen && <FullAccessDialog onClose={() => setFullAccessDialogOpen(false)}
      onConfirm={() => { setFullAccessDialogOpen(false); void selectPolicy("allow"); }} />}
    {settingsOpen && <SettingsDialog workspaces={bootstrap?.workspaces || []} runtime={runtime}
      theme={theme} onThemeChange={setTheme} onClose={() => setSettingsOpen(false)}
      onProvidersChanged={async () => {
        const source = activeSession || draftSession;
        if (!source) return;
        const next = await api.rpc<{ current: ModelEntry | null; providers: ModelEntry[] }>(source.id, "model.list");
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
