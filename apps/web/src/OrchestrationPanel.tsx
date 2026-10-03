import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

type Step = { id: string; title: string; status: string; note?: string };
type Plan = { id: string; title: string; revision: number; status: string; steps: Step[]; recovery_note?: string };
type WorkflowNode = { id: string; prompt: string; depends_on: string[]; status?: string; error?: string;
  result?: { output?: string; error?: string }; reconciliation?: string };
type WorkflowDefinition = { id: string; title: string; revision: number; kind: string; max_concurrency: number; nodes: WorkflowNode[] };
type WorkflowRun = WorkflowDefinition & { status: string; recovery_note?: string };
type Task = { id: string; title: string; description?: string; revision: number; status: string;
  depends_on: string[]; assignee?: string; result?: string; recovery_note?: string };
type Member = { id: string; role: string; label?: string };
type Mail = { id: string; from: string; message: string; created_at: string };
type Board = { owner_id: string; tasks: Record<string, Task>; members: Member[]; unread: number };
type WorkflowState = { definitions: Record<string, WorkflowDefinition>; runs: Record<string, WorkflowRun> };
const labels: Record<string, string> = { draft: "草稿", awaiting_approval: "等待批准", approved: "已批准", executing: "执行中",
  paused: "已暂停", rejected: "未批准", cancelled: "已取消", completed: "已完成", pending: "待开始",
  in_progress: "进行中", skipped: "已跳过", running: "执行中", failed: "失败", uncertain: "需要核对",
  todo: "待领取", claimed: "已领取", needs_review: "恢复后待核对" };
const statusLabel = (status: string) => labels[status] || status;
const errorText = (value: unknown) => value instanceof Error ? value.message : "操作失败，请刷新后核对";

export function OrchestrationPanel({ sessionId, onClose, onError }: {
  sessionId: string; onClose?: () => void; onError?: (error: unknown) => void;
}) {
  const [tab, setTab] = useState<"plan" | "workflow" | "team">("plan");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowState>({ definitions: {}, runs: {} });
  const [board, setBoard] = useState<Board>({ owner_id: "", tasks: {}, members: [], unread: 0 });
  const [mail, setMail] = useState<Mail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState("");
  const [workflowTitle, setWorkflowTitle] = useState("");
  const [kind, setKind] = useState("pipeline");
  const [concurrency, setConcurrency] = useState(2);
  const [nodes, setNodes] = useState<WorkflowNode[]>([{ id: "node1", prompt: "", depends_on: [] }]);
  const [taskTitle, setTaskTitle] = useState("");
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  const [taskResults, setTaskResults] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [reconciledResults, setReconciledResults] = useState<Record<string, string>>({});
  const scope = useRef(0);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  const reportError = useRef(onError);
  reportError.current = onError;

  const refresh = useCallback(async () => {
    const requestScope = scope.current;
    const values = await Promise.allSettled([
      api.rpc<{ plan: Plan | null }>(sessionId, "planning.show"),
      api.rpc<WorkflowState>(sessionId, "workflow.show"),
      api.rpc<Board>(sessionId, "team.show"),
      api.rpc<{ messages: Mail[] }>(sessionId, "team.mailbox"),
    ]);
    if (scope.current !== requestScope || currentSession.current !== sessionId) return;
    const [p, w, t, m] = values;
    if (p.status === "fulfilled") setPlan(p.value.plan);
    if (w.status === "fulfilled") setWorkflows(w.value);
    if (t.status === "fulfilled") setBoard(t.value);
    if (m.status === "fulfilled") setMail(m.value.messages);
    const failed = values.find((item) => item.status === "rejected");
    if (failed?.status === "rejected") setError(errorText(failed.reason));
  }, [sessionId]);

  useEffect(() => {
    scope.current += 1;
    setPlan(null); setWorkflows({ definitions: {}, runs: {} });
    setBoard({ owner_id: "", tasks: {}, members: [], unread: 0 }); setMail([]);
    setError(null); setBusy(null); setTitle(""); setSteps(""); setTaskResults({}); setEvidence({});
    setWorkflowTitle(""); setKind("pipeline"); setConcurrency(2); setNodes([{ id: "node1", prompt: "", depends_on: [] }]);
    setTaskTitle(""); setDependencies([]); setRecipient(""); setMessage(""); setReconciledResults({});
    void refresh();
    return () => { scope.current += 1; };
  }, [refresh]);

  const active = plan?.status === "awaiting_approval" || busy === "planning.submit"
    || Object.values(workflows.runs).some((run) => run.status === "running");
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void refresh(); }, 1200);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const invoke = async (method: string, params: Record<string, unknown> = {}) => {
    const requestScope = scope.current;
    setBusy(method); setError(null);
    try {
      await api.rpc(sessionId, method, params);
      if (scope.current === requestScope && currentSession.current === sessionId) await refresh();
    } catch (value) {
      if (scope.current === requestScope && currentSession.current === sessionId) {
        setError(errorText(value)); reportError.current?.(value);
      }
    } finally {
      if (scope.current === requestScope && currentSession.current === sessionId) setBusy(null);
    }
  };
  const planAction = (action: string, params: Record<string, unknown> = {}) =>
    invoke(`planning.${action}`, { expected_revision: plan?.revision, ...params });
  const taskAction = (task: Task, action: string, params: Record<string, unknown> = {}) =>
    invoke(`team.${action}`, { id: task.id, expected_revision: task.revision, ...params });
  const gateClosed = Boolean(plan && plan.status !== "executing");
  const tasks = Object.values(board.tasks);

  return <section className="orchestration-panel" aria-label="计划与协作">
    <header className="orchestration-header"><h2>计划与协作</h2><div>
      <button type="button" className="button ghost" onClick={() => { setError(null); void refresh(); }}>刷新</button>
      {onClose && <button type="button" className="button ghost" onClick={onClose}>关闭</button>}
    </div></header>
    <nav className="orchestration-tabs" aria-label="协作模块">{([
      ["plan", "计划"], ["workflow", "工作流"], ["team", `团队${board.unread ? ` · ${board.unread}` : ""}`],
    ] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={tab === value}
      onClick={() => setTab(value)}>{label}</button>)}</nav>
    {error && <p role="alert" className="orchestration-error">{error}</p>}

    {tab === "plan" && <div className="orchestration-body">
      <p>计划模式下仅开放只读工具。批准当前版本并开始执行后，才开放修改操作；暂停或恢复后需要重新批准。</p>
      {plan && <article className="orchestration-card">
        <h3>{plan.title} <span>{statusLabel(plan.status)}</span></h3>
        {plan.recovery_note && <p role="status">{plan.recovery_note}</p>}
        <ol>{plan.steps.map((step) => <li key={step.id}><div><strong>{step.title}</strong><span>{statusLabel(step.status)}</span></div>
          {step.note && <p>{step.note}</p>}
          {plan.status === "executing" && !["completed", "skipped"].includes(step.status) && <div className="orchestration-actions">
            <button type="button" disabled={Boolean(busy)} onClick={() => void planAction("step", { step_id: step.id, status: "in_progress" })}>开始步骤</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void planAction("step", { step_id: step.id, status: "completed" })}>标记完成</button>
          </div>}</li>)}</ol>
        <div className="orchestration-actions">
          {["draft", "paused", "rejected"].includes(plan.status) && <button type="button" disabled={Boolean(busy)} onClick={() => void planAction("submit")}>提交批准</button>}
          {plan.status === "approved" && <button type="button" disabled={Boolean(busy)} onClick={() => void planAction("start")}>开始执行</button>}
          {plan.status === "executing" && <button type="button" disabled={Boolean(busy)} onClick={() => void planAction("pause")}>暂停</button>}
          {plan.status === "paused" && <button type="button" disabled={Boolean(busy)} onClick={() => void planAction("resume")}>恢复草稿</button>}
          {!["completed", "cancelled"].includes(plan.status) && <button type="button" disabled={Boolean(busy && busy !== "planning.submit")}
            onClick={() => void planAction("cancel")}>取消计划</button>}
          <button type="button" disabled={Boolean(busy && busy !== "planning.submit")} onClick={() => void planAction("exit")}>退出计划模式</button>
        </div>
        {plan.status === "awaiting_approval" && <p role="status">请在会话中的批准提示里确认。等待期间不会开始执行。</p>}
      </article>}
      {(!plan || ["cancelled", "completed", "rejected", "draft", "paused", "approved"].includes(plan.status)) &&
        <form className="orchestration-form" onSubmit={(event) => {
          event.preventDefault();
          const nextSteps = steps.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => ({ id: `step${index + 1}`, title: line }));
          if (!nextSteps.length) return;
          void planAction(plan && ["draft", "paused", "approved"].includes(plan.status) ? "update" : "create", { title, steps: nextSteps });
        }}>
          <label>计划名称<input value={title} required maxLength={200} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>步骤，每行一项<textarea value={steps} required rows={4} onChange={(event) => setSteps(event.target.value)} /></label>
          <button type="submit" disabled={Boolean(busy)}>{plan && ["draft", "paused", "approved"].includes(plan.status) ? "保存新版本" : "创建计划"}</button>
        </form>}
    </div>}

    {tab === "workflow" && <div className="orchestration-body">
      <p>将研究任务串行、并行或按依赖执行。每个节点使用现有子代理权限；运行记录会保留，结果未知的节点需要核对后恢复。</p>
      {gateClosed && <p role="status">当前计划尚未进入执行状态，工作流启动已锁定。</p>}
      {Object.values(workflows.definitions).map((definition) => <article className="orchestration-card" key={definition.id}>
        <h3>{definition.title}</h3><p>{definition.nodes.length} 个步骤 · 最多同时运行 {definition.max_concurrency} 个</p>
        <button type="button" disabled={Boolean(busy) || gateClosed} onClick={() => void invoke("workflow.run", { id: definition.id, expected_revision: definition.revision })}>运行工作流</button>
      </article>)}
      {Object.values(workflows.runs).map((run) => <article className="orchestration-card" key={run.id}>
        <h3>{run.title} <span>{statusLabel(run.status)}</span></h3>
        {run.recovery_note && <p>{run.recovery_note}</p>}
        <ol>{run.nodes.map((node) => {
          const key = `${run.id}:${node.id}`;
          return <li key={node.id}><div><strong>{node.prompt}</strong><span>{statusLabel(node.status || "pending")}</span></div>
            {(node.result?.output || node.result?.error || node.error) && <details><summary>查看结果</summary><pre>{node.result?.output || node.result?.error || node.error}</pre></details>}
            {node.status === "uncertain" && <div className="orchestration-form">
              <label>核对依据<textarea value={evidence[key] || ""} maxLength={4000} onChange={(event) => setEvidence({ ...evidence, [key]: event.target.value })} /></label>
              <label>已确认的结果<textarea value={reconciledResults[key] || ""} onChange={(event) => setReconciledResults({ ...reconciledResults, [key]: event.target.value })} /></label>
              <div className="orchestration-actions">
                <button type="button" disabled={Boolean(busy) || !evidence[key]?.trim() || !reconciledResults[key]?.trim()} onClick={() => void invoke("workflow.reconcile", {
                  run_id: run.id, node_id: node.id, expected_revision: run.revision, status: "completed", evidence: evidence[key],
                  result: { output: reconciledResults[key], "stop-reason": "completed" },
                })}>确认已完成</button>
                <button type="button" disabled={Boolean(busy) || !evidence[key]?.trim()} onClick={() => void invoke("workflow.reconcile", {
                  run_id: run.id, node_id: node.id, expected_revision: run.revision, status: "pending", evidence: evidence[key],
                })}>确认可重试</button>
                <button type="button" disabled={Boolean(busy) || !evidence[key]?.trim()} onClick={() => void invoke("workflow.reconcile", {
                  run_id: run.id, node_id: node.id, expected_revision: run.revision, status: "skipped", evidence: evidence[key],
                })}>跳过节点</button>
              </div>
            </div>}</li>;
        })}</ol>
        <div className="orchestration-actions">
          {["running", "uncertain"].includes(run.status) && <button type="button" disabled={Boolean(busy)} onClick={() => void invoke("workflow.cancel", { run_id: run.id, expected_revision: run.revision })}>取消运行</button>}
          {run.status === "uncertain" && <button type="button" disabled={Boolean(busy) || gateClosed || run.nodes.some((node) => node.status === "uncertain")}
            onClick={() => void invoke("workflow.resume", { run_id: run.id, expected_revision: run.revision })}>恢复已核对的运行</button>}
          {["completed", "failed", "cancelled"].includes(run.status) && <button type="button" disabled={Boolean(busy)} onClick={() => void invoke("workflow.delete", { run_id: run.id, expected_revision: run.revision })}>移除运行记录</button>}
        </div>
      </article>)}
      <details className="orchestration-card"><summary>创建工作流</summary><form className="orchestration-form" onSubmit={(event) => {
        event.preventDefault(); void invoke("workflow.define", { id: `wf-${crypto.randomUUID().slice(0, 8)}`, title: workflowTitle, kind, max_concurrency: concurrency, nodes });
      }}>
        <label>工作流名称<input required maxLength={200} value={workflowTitle} onChange={(event) => setWorkflowTitle(event.target.value)} /></label>
        <label>执行方式<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="pipeline">依次执行</option><option value="parallel">并行执行</option><option value="dag">按步骤依赖执行</option></select></label>
        <label>同时运行数量<input type="number" min={1} max={4} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></label>
        {nodes.map((node, index) => <fieldset key={node.id}><legend>步骤 {index + 1}</legend>
          <label>任务描述<textarea required value={node.prompt} maxLength={12000} onChange={(event) => setNodes(nodes.map((item) => item.id === node.id ? { ...item, prompt: event.target.value } : item))} /></label>
          {kind === "dag" && <label>等待这些步骤完成<select multiple value={node.depends_on} onChange={(event) => setNodes(nodes.map((item) => item.id === node.id ? { ...item, depends_on: Array.from(event.target.selectedOptions, (option) => option.value) } : item))}>
            {nodes.filter((item) => item.id !== node.id).map((item) => <option value={item.id} key={item.id}>步骤 {nodes.indexOf(item) + 1} · {item.prompt.slice(0, 36)}</option>)}
          </select></label>}
        </fieldset>)}
        <button type="button" disabled={nodes.length >= 64} onClick={() => setNodes([...nodes, { id: `node${nodes.length + 1}`, prompt: "", depends_on: [] }])}>添加步骤</button>
        <button type="submit" disabled={Boolean(busy)}>保存工作流</button>
      </form></details>
    </div>}

    {tab === "team" && <div className="orchestration-body">
      <p>任务板协调当前会话和已注册子代理。领取和完成会校验版本与依赖，避免重复领取；不会自动扩大子代理的工具权限。</p>
      {tasks.map((task) => <article className="orchestration-card" key={task.id}>
        <h3>{task.title} <span>{statusLabel(task.status)}</span></h3>
        <p>{task.assignee ? `负责人：${board.members.find((member) => member.id === task.assignee)?.label || (task.assignee === board.owner_id ? "当前会话" : task.assignee)}` : "尚未分配"}</p>
        {task.depends_on.length > 0 && <p>等待：{task.depends_on.map((id) => board.tasks[id]?.title || id).join("、")}</p>}
        {task.result && <details><summary>完成结果</summary><pre>{task.result}</pre></details>}
        {task.status === "todo" && <div className="orchestration-actions">
          <select aria-label={`分配 ${task.title}`} value={task.assignee || ""} disabled={Boolean(busy)} onChange={(event) => { if (event.target.value) void taskAction(task, "assign", { assignee: event.target.value }); }}>
            <option value="">选择负责人</option>{board.members.map((member) => <option key={member.id} value={member.id}>{member.role === "owner" ? "当前会话" : member.label || member.id}</option>)}
          </select>
          <button type="button" disabled={Boolean(busy) || Boolean(task.assignee && task.assignee !== board.owner_id) || task.depends_on.some((id) => board.tasks[id]?.status !== "completed")}
            onClick={() => void taskAction(task, "claim")}>当前会话领取</button>
        </div>}
        {["claimed", "needs_review"].includes(task.status) && <div className="orchestration-form">
          <label>结果说明<textarea maxLength={16000} value={taskResults[task.id] || ""} onChange={(event) => setTaskResults({ ...taskResults, [task.id]: event.target.value })} /></label>
          {task.status === "needs_review" && <label>恢复核对依据<textarea maxLength={4000} value={evidence[task.id] || ""} onChange={(event) => setEvidence({ ...evidence, [task.id]: event.target.value })} /></label>}
          <button type="button" disabled={Boolean(busy) || !taskResults[task.id]?.trim() || (task.status === "needs_review" && !evidence[task.id]?.trim())}
            onClick={() => void taskAction(task, "complete", { result: taskResults[task.id], evidence: evidence[task.id] })}>确认完成</button>
        </div>}
        <div className="orchestration-actions">
          {task.status !== "todo" && <button type="button" disabled={Boolean(busy) || (task.status === "needs_review" && !evidence[task.id]?.trim())}
            onClick={() => void taskAction(task, "reopen", { evidence: evidence[task.id] })}>重新开放</button>}
          {!["cancelled", "completed"].includes(task.status) && <button type="button" disabled={Boolean(busy)} onClick={() => void taskAction(task, "cancel")}>取消任务</button>}
        </div>
      </article>)}
      <form className="orchestration-form" onSubmit={(event) => { event.preventDefault(); void invoke("team.create", { id: `task-${crypto.randomUUID().slice(0, 8)}`, title: taskTitle, depends_on: dependencies }); }}>
        <label>新增任务<input required maxLength={1000} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} /></label>
        <label>前置任务<select multiple value={dependencies} onChange={(event) => setDependencies(Array.from(event.target.selectedOptions, (option) => option.value))}>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
        <button type="submit" disabled={Boolean(busy)}>添加任务</button>
      </form>
      <h3>当前会话收件箱</h3>{mail.length === 0 && <p>没有未读消息</p>}
      {mail.map((entry) => <article className="orchestration-card" key={entry.id}><strong>{board.members.find((member) => member.id === entry.from)?.label || entry.from}</strong><p>{entry.message}</p>
        <button type="button" disabled={Boolean(busy)} onClick={() => void invoke("team.ack", { message_ids: [entry.id] })}>确认收到</button></article>)}
      <form className="orchestration-form" onSubmit={(event) => { event.preventDefault(); void invoke("team.send", { recipient, message }); }}>
        <label>收件人<select required value={recipient} onChange={(event) => setRecipient(event.target.value)}><option value="">选择成员</option>{board.members.map((member) => <option key={member.id} value={member.id}>{member.role === "owner" ? "当前会话" : member.label || member.id}</option>)}</select></label>
        <label>消息<textarea required maxLength={8000} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
        <button type="submit" disabled={Boolean(busy)}>发送到成员邮箱</button>
      </form>
    </div>}
  </section>;
}
