import { MarkdownContent } from "./MarkdownContent";
import type { SubagentStatus } from "./types";
import { Icon } from "./icons";

export function SubagentPanel({ jobs }: { jobs: SubagentStatus["jobs"] }) {
  if (!jobs.length) return null;
  const labels: Record<string, string> = { running: "运行中", completed: "已完成 · 尚未验收",
    failed: "失败", cancelled: "已取消", uncertain: "结果未确认" };
  return <section className="subagent-panel" aria-label="子任务">
    {jobs.map(job => <details key={job.id} className="subagent-disclosure">
      <summary><Icon name="chevron" /><span>{job.label || job.id}</span><small>{labels[job.status] || job.status}</small></summary>
      <div className="subagent-result"><p>{job.provider} · {job.id}</p>
        {job.result != null ? <MarkdownContent content={typeof job.result === "string"
          ? job.result : JSON.stringify(job.result, null, 2)} /> : <p>暂无已返回的结果</p>}
      </div>
    </details>)}
  </section>;
}
