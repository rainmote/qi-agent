import { uiText as t } from "./i18n";
import type { ContextStatus } from "./types";
import { contextBudgetExplanation, contextTokenCount } from "./context-budget";

type RunOverviewProps = {
  phase: string;
  turns: number;
  steps: number;
  calls: number;
  waitingCount: number;
  context: ContextStatus | null;
};

export function RunOverview({ phase, turns, steps, calls, waitingCount, context }: RunOverviewProps) {
  const phaseText = ({ idle: t("就绪"), model: t("模型响应"), tool: t("执行工具"), retry: t("正在重试"),
    compacting: t("整理上下文"), stopping: t("正在停止") } as Record<string, string>)[phase] || phase;
  const used = contextTokenCount(context?.used_tokens);
  const limit = contextTokenCount(context?.context_window, true);

  return <section className="run-overview" role="region" aria-label={t("运行概览")}>
    <div className="run-overview-inner">
      <div className="run-overview-heading">
        <h2>{t("运行概览")}</h2>
        <span className="run-overview-phase" role="status" aria-atomic="true">{phaseText}</span>
      </div>
      <dl className="run-overview-metrics">
        <div><dt>{t("轮次")}</dt><dd>{turns}</dd></div>
        <div><dt>{t("步数")}</dt><dd>{steps}</dd></div>
        <div><dt>{t("工具调用")}</dt><dd>{calls}</dd></div>
        <div className={`run-overview-waiting ${waitingCount > 0 ? "needs-attention" : ""}`}
          role="status" aria-atomic="true"><dt>{t("待确认")}</dt><dd>{waitingCount}{" " + t("项")}</dd></div>
        <div className="run-overview-context"><dt>{t("上下文")}</dt>
          <dd>{context ? t("估算 {0} / {1} tokens", used, limit) : t("未知")}</dd></div>
      </dl>
      {context && <details className="context-budget-explanation">
        <summary>{t("上下文预算说明")}</summary>
        <p>{contextBudgetExplanation(context)}</p>
      </details>}
    </div>
  </section>;
}
