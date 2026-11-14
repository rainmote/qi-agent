import type { DurableEvent } from "./types";
import { uiText as t } from "./i18n";

/** Retain the structured failure cue without disclosing stdout/stderr in a collapsed row. */
export function toolFailureSummary(result: DurableEvent): string {
  const details = result.data.details as Record<string, unknown> | undefined;
  const exit = details?.["exit-code"];
  return typeof exit === "number" && Number.isInteger(exit) && exit !== 0
    ? t("命令失败 · exit {0} · 展开查看详情", exit) : t("调用失败，展开查看详情");
}

/** Transport success is independent of command success. Never infer failure from output prose. */
export function toolFailed(result: DurableEvent | undefined): boolean {
  if (!result) return false;
  const data = result.data;
  const details = data.details as Record<string, unknown> | undefined;
  const exit = details?.["exit-code"];
  return data.ok === false || data["is-error"] === true || data.status === "error"
    || (data.name === "bash" && typeof exit === "number" && exit !== 0);
}
