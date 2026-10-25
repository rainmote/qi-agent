import { uiLocale, uiText as t } from "./i18n";
import { useEffect, useRef, useState, type FormEvent } from "react";

export interface ScheduleEntry {
  schedule_id: string; expression: string; next_at_ms: number | null; status: string; revision: number;
  policy: { prompt: string; timezone?: string; last_error?: string };
}
export interface GoalEntry {
  goal_id: string; objective: string; status: string; revision: number;
  continuation_count: number; max_continuations: number; last_error?: string;
}
export type AutomationRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type Timing = "daily" | "weekly" | "expression" | "delay_ms" | "at_ms";
export function scheduleParameters(prompt: string, timing: Timing, value: string, timezone: string) {
  if (!prompt.trim()) throw new Error(t("请填写任务内容"));
  new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format();
  if (timing === "at_ms") {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) throw new Error(t("请选择有效日期和时间"));
    return { prompt: prompt.trim(), at_ms: timestamp, timezone };
  }
  if (timing === "delay_ms") {
    const minutes = Number(value);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(t("延迟分钟数必须大于 0"));
    return { prompt: prompt.trim(), delay_ms: Math.round(minutes * 60000), timezone };
  }
  if (!value.trim()) throw new Error(t("请填写执行时间"));
  return { prompt: prompt.trim(), [timing]: value.trim(), timezone };
}
const labels: Record<string, string> = { active: "运行中", paused: "已暂停", claimed: "正在发送", uncertain: "结果待核对",
  failed: "失败", completed: "已完成", cancelled: "已取消", blocked: "受阻", budget_exhausted: "续跑次数已用完", superseded: "已替换" };
const terminal = (status: string) => ["completed", "cancelled", "superseded"].includes(status);

export function AutomationPanel({ rpc, agentId, readOnly = false }: { rpc: AutomationRpc; agentId: string; readOnly?: boolean }) {
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [goals, setGoals] = useState<GoalEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [timing, setTiming] = useState<Timing>("daily");
  const [time, setTime] = useState("09:00");
  const [zone, setZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [editingSchedule, setEditingSchedule] = useState<ScheduleEntry | null>(null);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState(3);
  const [editingGoal, setEditingGoal] = useState<GoalEntry | null>(null);
  const [reconciled, setReconciled] = useState<Record<string, boolean>>({});
  const scope = useRef(0);
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const refresh = async (generation = scope.current) => {
    const result = await Promise.all([rpcRef.current("schedule.list", {}), rpcRef.current("goal.list", {})]);
    if (generation !== scope.current) return;
    setSchedules(result[0] as ScheduleEntry[]); setGoals(result[1] as GoalEntry[]);
  };
  useEffect(() => {
    const generation = ++scope.current;
    setSchedules([]); setGoals([]); setEditingSchedule(null); setEditingGoal(null);
    setPrompt(""); setObjective(""); setReconciled({}); setError(""); setBusy(true);
    void refresh(generation).catch(value => {
      if (scope.current === generation) setError(value instanceof Error ? value.message : t("无法读取自动化任务"));
    }).finally(() => { if (scope.current === generation) setBusy(false); });
    return () => { scope.current++; };
  }, [agentId]);
  const run = async (method: string, params: Record<string, unknown>, done?: () => void) => {
    if (busy || readOnly) return;
    const generation = scope.current; setBusy(true); setError("");
    try {
      await rpcRef.current(method, params);
      if (generation !== scope.current) return;
      done?.(); await refresh(generation);
    } catch (value) {
      if (generation === scope.current) setError(value instanceof Error ? value.message : t("操作失败，请刷新后核对状态"));
    } finally { if (generation === scope.current) setBusy(false); }
  };
  const submitSchedule = (event: FormEvent) => {
    event.preventDefault();
    try {
      const params = scheduleParameters(prompt, timing, time, zone);
      void run(editingSchedule ? "schedule.update" : "schedule.add", { ...params,
        ...(editingSchedule ? { schedule_id: editingSchedule.schedule_id, expected_revision: editingSchedule.revision } : {}) },
      () => { setEditingSchedule(null); setPrompt(""); });
    } catch (value) { setError(value instanceof Error ? value.message : t("时间格式不正确")); }
  };
  const submitGoal = (event: FormEvent) => {
    event.preventDefault();
    void run(editingGoal ? "goal.update" : "goal.set", { objective: objective.trim(), max_continuations: budget,
      ...(editingGoal ? { goal_id: editingGoal.goal_id, expected_revision: editingGoal.revision } : {}) },
    () => { setEditingGoal(null); setObjective(""); });
  };
  const disabled = busy || readOnly;
  return <div className="management-panel automation-panel" aria-busy={busy}>
    <div className="automation-toolbar"><h2>{t("计划任务与长期目标")}</h2>
      <button type="button" className="button secondary" disabled={busy} onClick={() => {
        const generation = scope.current; setBusy(true); setError("");
        void refresh(generation).catch(value => { if (scope.current === generation) setError(String(value)); })
          .finally(() => { if (scope.current === generation) setBusy(false); });
      }}>{t("刷新")}</button></div>
    {readOnly && <p>{t("当前为只读会话，取得控制权后可管理任务。")}</p>}
    {error && <p role="alert" className="automation-error">{error}</p>}
    <section aria-labelledby="schedules-title"><h3 id="schedules-title">{t("计划任务")}</h3>
      <p>{t("由后台按时触发。时区夏令时跳过不存在的时间，重复的本地时间只执行一次。")}</p>
      <form onSubmit={submitSchedule} className="automation-form">
        <label>{t("任务内容")}<textarea value={prompt} onChange={e => setPrompt(e.target.value)} required disabled={disabled} /></label>
        <div className="automation-fields"><label>{t("执行规则")}<select value={timing} disabled={disabled} onChange={e => {
          const next = e.target.value as Timing; setTiming(next); setTime({ daily: "09:00", weekly: "MON 09:00", expression: "0 9 * * 1-5", delay_ms: "10", at_ms: "" }[next]);
        }}><option value="daily">{t("每天")}</option><option value="weekly">{t("每周")}</option><option value="expression">{t("Cron 表达式")}</option><option value="delay_ms">{t("延迟一次")}</option><option value="at_ms">{t("指定时间一次")}</option></select></label>
        <label>{timing === "delay_ms" ? t("多少分钟后") : timing === "at_ms" ? t("日期时间（本机时区）") : t("执行时间")}<input type={timing === "at_ms" ? "datetime-local" : "text"} value={time} disabled={disabled} required onChange={e => setTime(e.target.value)}
          placeholder={timing === "weekly" ? "MON,WED 09:00" : timing === "expression" ? "0 9 * * 1-5" : "09:00"} /></label>
        <label>{t("时区")}<input value={zone} disabled={disabled} required onChange={e => setZone(e.target.value)} placeholder="Asia/Hong_Kong" /></label></div>
        <div className="automation-actions"><button className="button primary" disabled={disabled || !prompt.trim()}>{editingSchedule ? t("保存任务") : t("创建计划任务")}</button>
          {editingSchedule && <button type="button" className="button ghost" onClick={() => { setEditingSchedule(null); setPrompt(""); }}>{t("取消编辑")}</button>}</div>
      </form>
      {!schedules.length && <p>{t("暂无计划任务。")}</p>}
      {schedules.map(row => <article className="automation-entry" key={row.schedule_id}>
        <div className="automation-toolbar"><strong>{row.policy.prompt}</strong><span>{labels[row.status] ? t(labels[row.status]) : row.status}</span></div>
        <p>{row.expression} · {row.policy.timezone || "UTC"}</p>
        {row.next_at_ms && <p>{t("下次：")}{new Intl.DateTimeFormat(uiLocale(), { timeZone: row.policy.timezone || "UTC", dateStyle: "medium", timeStyle: "short" }).format(row.next_at_ms)}</p>}
        {row.policy.last_error && <p className="automation-error">{row.policy.last_error}</p>}
        {row.status === "uncertain" && <p>{t("此前发送结果未知，请先核对会话；不会自动重发。")}</p>}
        <div className="automation-actions">
          {["active", "paused", "failed"].includes(row.status) && <button type="button" className="button secondary" disabled={disabled} onClick={() => {
            setEditingSchedule(row); setPrompt(row.policy.prompt); setZone(row.policy.timezone || "UTC");
            if (row.expression.startsWith("at:")) {
              const date = new Date(Number(row.expression.slice(3)));
              setTiming("at_ms"); setTime(new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
            } else { setTiming("expression"); setTime(row.expression); }
          }}>{t("编辑任务")}</button>}
          {["active", "paused", "failed"].includes(row.status) && <button type="button" className="button secondary" disabled={disabled} onClick={() => void run(`schedule.${row.status === "active" ? "pause" : "resume"}`,
            { schedule_id: row.schedule_id, expected_revision: row.revision })}>{row.status === "active" ? t("暂停") : t("恢复")}</button>}
          {!terminal(row.status) && <button type="button" className="button ghost" disabled={disabled} onClick={() => void run("schedule.cancel", { schedule_id: row.schedule_id, expected_revision: row.revision })}>{t("取消任务")}</button>}
        </div>
      </article>)}
    </section>
    <section aria-labelledby="goals-title"><h3 id="goals-title">{t("长期目标")}</h3>
      <p>{t("每次回复后按预算继续推进。暂停或完成只停止后续续跑，当前回合会继续结束。")}</p>
      <form className="automation-form" onSubmit={submitGoal}>
        <label>{t("目标")}<textarea value={objective} disabled={disabled} required onChange={e => setObjective(e.target.value)} /></label>
        <label>{t("最多续跑次数（0–20）")}<input type="number" min={editingGoal?.continuation_count || 0} max={20} value={budget} disabled={disabled} required onChange={e => setBudget(Number(e.target.value))} /></label>
        <div className="automation-actions"><button className="button primary" disabled={disabled || !objective.trim() || (!editingGoal && goals.some(row => !terminal(row.status)))}>{editingGoal ? t("保存目标") : t("创建并开始")}</button>
          {editingGoal && <button type="button" className="button ghost" onClick={() => { setEditingGoal(null); setObjective(""); }}>{t("取消编辑")}</button>}</div>
      </form>
      {!goals.length && <p>{t("暂无长期目标。")}</p>}
      {goals.map(row => <article className="automation-entry" key={row.goal_id}>
        <div className="automation-toolbar"><strong>{row.objective}</strong><span>{labels[row.status] ? t(labels[row.status]) : row.status}</span></div>
        <p>{t("已续跑") + " "}{row.continuation_count} / {row.max_continuations}{" " + t("次")}</p>
        {row.last_error && <p className="automation-error">{row.last_error}</p>}
        {row.status === "uncertain" && <label className="automation-check"><input type="checkbox" checked={!!reconciled[row.goal_id]} disabled={disabled}
          onChange={e => setReconciled(previous => ({ ...previous, [row.goal_id]: e.target.checked }))} />{t("已核对之前操作的实际结果")}</label>}
        {!terminal(row.status) && <div className="automation-actions">
          <button type="button" className="button secondary" disabled={disabled} onClick={() => { setEditingGoal(row); setObjective(row.objective); setBudget(row.max_continuations); }}>{t("编辑目标")}</button>
          <button type="button" className="button secondary" disabled={disabled || (row.status !== "active" && (row.continuation_count >= row.max_continuations || (row.status === "uncertain" && !reconciled[row.goal_id])))}
            onClick={() => void run(`goal.${row.status === "active" ? "pause" : "resume"}`, { goal_id: row.goal_id, expected_revision: row.revision, reconciled: !!reconciled[row.goal_id] })}>{row.status === "active" ? t("暂停") : t("恢复")}</button>
          <button type="button" className="button secondary" disabled={disabled} onClick={() => void run("goal.complete", { goal_id: row.goal_id, expected_revision: row.revision })}>{t("标记已完成")}</button>
          <button type="button" className="button ghost" disabled={disabled} onClick={() => void run("goal.cancel", { goal_id: row.goal_id, expected_revision: row.revision })}>{t("取消目标")}</button>
        </div>}
      </article>)}
    </section>
  </div>;
}
