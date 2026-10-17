import type { RunOutcome } from "./types";

export function runOutcome(value: unknown): RunOutcome | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = raw["run-id"] ?? raw.run_id;
  if (typeof id !== "string" || !id || !["completed", "failed", "cancelled", "uncertain"].includes(String(raw.status))) return null;
  return { ...raw, "run-id": id } as unknown as RunOutcome;
}

export function outcomeText(outcome: RunOutcome): string {
  const execution = { completed: "运行完成", failed: "运行失败", cancelled: "运行已取消", uncertain: "结果未确认 · 需要核对" }[outcome.status];
  const verification = typeof outcome.verification === "object" ? outcome.verification?.status : outcome.verification;
  const checked = verification === "passed" || verification === "verified" ? "验收通过"
    : verification === "failed" ? "验收失败" : verification === "unknown" ? "验收结果未知" : "尚未验收";
  const reasons: Record<string, string> = { "no-progress": "连续调用没有进展", "step-budget": "步数已达上限",
    "request-budget": "请求数已达上限", "wall-budget": "运行时间已达上限", "tool-terminated": "工具策略终止",
    "provider-error": "模型请求失败", "summary-failed": "上下文整理失败", "output-limit": "输出达到上限", restored: "中断后恢复" };
  return [execution, checked, outcome.reason && reasons[outcome.reason], outcome.error].filter(Boolean).join(" · ");
}
