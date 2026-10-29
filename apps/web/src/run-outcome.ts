import { uiText as t } from "./i18n";
import type { RunOutcome } from "./types";

export function runOutcome(value: unknown): RunOutcome | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = raw["run-id"] ?? raw.run_id;
  if (typeof id !== "string" || !id || !["completed", "failed", "cancelled", "uncertain"].includes(String(raw.status))) return null;
  return { ...raw, "run-id": id } as unknown as RunOutcome;
}

/** Host deadline arbitration can correct an earlier worker terminal, never the reverse. */
export function effectiveOutcome(existing: RunOutcome | null, incoming: RunOutcome): RunOutcome {
  const arbitrated = (outcome: RunOutcome) => outcome.status === "uncertain"
    && (outcome["host-arbitrated"] === true || outcome.host_arbitrated === true);
  return !existing || (arbitrated(incoming) && !arbitrated(existing)) ? incoming : existing;
}

export function outcomeText(outcome: RunOutcome): string {
  const execution = { completed: t("运行完成"), failed: t("运行失败"), cancelled: t("运行已取消"), uncertain: t("结果未确认 · 需要核对") }[outcome.status];
  const verification = typeof outcome.verification === "object" ? outcome.verification?.status : outcome.verification;
  const checked = verification === "passed" || verification === "verified" ? t("验收通过")
    : verification === "failed" ? t("验收失败") : verification === "unknown" ? t("验收结果未知") : t("尚未验收");
  const reasons: Record<string, string> = { "no-progress": t("连续调用没有进展"), "step-budget": t("步数已达上限"),
    "request-budget": t("请求数已达上限"), "wall-budget": t("运行时间已达上限"), "tool-terminated": t("工具策略终止"),
    "provider-error": t("模型请求失败"), "summary-failed": t("上下文整理失败"), "output-limit": t("输出达到上限"), restored: t("中断后恢复") };
  return [execution, checked, outcome.reason && reasons[outcome.reason], outcome.error].filter(Boolean).join(" · ");
}
