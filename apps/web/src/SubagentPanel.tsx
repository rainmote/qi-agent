import { uiText as t } from "./i18n";
import { useState } from "react";
import { useComposerPopover } from "./ComposerControls";
import { MarkdownContent } from "./MarkdownContent";
import type { SubagentStatus } from "./types";
import { Icon } from "./icons";

export function SubagentPanel({ jobs }: { jobs: SubagentStatus["jobs"] }) {
  if (!jobs.length) return null;
  const labels: Record<string, string> = { running: t("运行中"), completed: t("已完成 · 尚未验收"),
    failed: t("失败"), cancelled: t("已取消"), uncertain: t("结果未确认") };
  return <section className="subagent-panel" aria-label={t("子任务")}>
    {jobs.map(job => <details key={job.id} className="subagent-disclosure">
      <summary><Icon name="chevron" /><span>{job.label || job.id}</span><small>{labels[job.status] || job.status}</small></summary>
      <div className="subagent-result"><p>{job.provider} · {job.id}</p>
        {job.result != null ? <MarkdownContent content={typeof job.result === "string"
          ? job.result : JSON.stringify(job.result, null, 2)} /> : <p>{t("暂无已返回的结果")}</p>}
      </div>
    </details>)}
  </section>;
}

/** One header menu retains full job results while leaving the composer in place. */
export function SubagentMenu({ jobs }: { jobs: SubagentStatus["jobs"] }) {
  const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, () => setOpen(false), false, "below");
  return <div className="session-subagents" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button ref={popover.trigger} type="button" className="session-subagents-trigger" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(value => !value)}>{jobs.length}{" " + t("个子智能体")}<Icon name="chevron" /></button>
    {open && <div ref={popover.panel} className="composer-popover session-subagents-popover" role="dialog" aria-label={t("子智能体")}><SubagentPanel jobs={jobs} /></div>}
  </div>;
}
