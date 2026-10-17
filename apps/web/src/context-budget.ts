import type { ContextStatus } from "./types";

const tokens = (value: unknown, positive = false): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
export const contextTokenCount = (value: unknown, positive = false): string =>
  tokens(value, positive) ? value.toLocaleString("zh-CN") : "未知";

export function contextBudgetExplanation(status: ContextStatus): string {
  const basis = status.basis === "last-request" ? "上一请求" : status.basis === "next-request" ? "下一请求" : "请求口径未知";
  const reserve = tokens(status.reserve_tokens)
    ? `${status.basis === "next-request" ? "为下一次回答" : status.basis === "last-request" ? "上一请求为回答" : "为回答"}预留 ${contextTokenCount(status.reserve_tokens)} tokens`
    : "回答预留未知";
  const complete = tokens(status.used_tokens) && tokens(status.context_window, true)
    && tokens(status.reserve_tokens) && tokens(status.input_limit)
    && status.input_limit + status.reserve_tokens <= status.context_window;
  const consistent = complete && !(status.fits === true && status.used_tokens > status.input_limit!);
  const fit = consistent && typeof status.fits === "boolean"
    ? status.fits ? "在输入预算内" : "超过输入预算"
    : "是否符合输入预算未知";
  return `${basis} · 估算输入 ${contextTokenCount(status.used_tokens)} / ${contextTokenCount(status.context_window, true)} tokens。${reserve}；输入预算 ${contextTokenCount(status.input_limit)} tokens；请求选项 ${contextTokenCount(status.option_tokens)} tokens。${fit}。`;
}
