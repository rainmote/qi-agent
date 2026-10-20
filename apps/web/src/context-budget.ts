import { uiText as t } from "./i18n";
import type { ContextStatus } from "./types";

const tokens = (value: unknown, positive = false): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
export const contextTokenCount = (value: unknown, positive = false): string =>
  tokens(value, positive) ? value.toLocaleString("zh-CN") : t("未知");

export function contextBudgetExplanation(status: ContextStatus): string {
  const basis = status.basis === "last-request" ? t("上一请求") : status.basis === "next-request" ? t("下一请求") : t("请求口径未知");
  const reserve = tokens(status.reserve_tokens)
    ? t("{0}预留 {1} tokens", status.basis === "next-request" ? t("为下一次回答") : status.basis === "last-request" ? t("上一请求为回答") : t("为回答"), contextTokenCount(status.reserve_tokens))
    : t("回答预留未知");
  const complete = tokens(status.used_tokens) && tokens(status.context_window, true)
    && tokens(status.reserve_tokens) && tokens(status.input_limit)
    && status.input_limit + status.reserve_tokens <= status.context_window;
  const consistent = complete && !(status.fits === true && status.used_tokens > status.input_limit!);
  const fit = consistent && typeof status.fits === "boolean"
    ? status.fits ? t("在输入预算内") : t("超过输入预算")
    : t("是否符合输入预算未知");
  return t("{0} · 估算输入 {1} / {2} tokens。{3}；输入预算 {4} tokens；请求选项 {5} tokens。{6}。", basis, contextTokenCount(status.used_tokens), contextTokenCount(status.context_window, true), reserve, contextTokenCount(status.input_limit), contextTokenCount(status.option_tokens), fit);
}
