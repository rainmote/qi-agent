import type { ContextStatus } from "./types";

type RunOverviewProps = {
  phase: string;
  turns: number;
  steps: number;
  calls: number;
  waitingCount: number;
  context: ContextStatus | null;
};

export function RunOverview({ phase, turns, steps, calls, waitingCount, context }: RunOverviewProps) {
  const phaseText = ({ idle: "就绪", model: "模型响应", tool: "执行工具", retry: "正在重试",
    compacting: "整理上下文", stopping: "正在停止" } as Record<string, string>)[phase] || phase;
  const used = context && Number.isFinite(context.used_tokens) && context.used_tokens >= 0
    ? context.used_tokens.toLocaleString("zh-CN") : "未知";
  const limit = context && Number.isFinite(context.context_window) && context.context_window > 0
    ? context.context_window.toLocaleString("zh-CN") : "未知";

  return <section className="run-overview" role="region" aria-label="运行概览">
    <div className="run-overview-inner">
      <div className="run-overview-heading">
        <h2>运行概览</h2>
        <span className="run-overview-phase" role="status" aria-atomic="true">{phaseText}</span>
      </div>
      <dl className="run-overview-metrics">
        <div><dt>轮次</dt><dd>{turns}</dd></div>
        <div><dt>步数</dt><dd>{steps}</dd></div>
        <div><dt>工具调用</dt><dd>{calls}</dd></div>
        <div className={`run-overview-waiting ${waitingCount > 0 ? "needs-attention" : ""}`}
          role="status" aria-atomic="true"><dt>待确认</dt><dd>{waitingCount} 项</dd></div>
        <div className="run-overview-context"><dt>上下文</dt>
          <dd>{context ? `${used} / ${limit} tokens` : "未知"}</dd></div>
      </dl>
    </div>
  </section>;
}
