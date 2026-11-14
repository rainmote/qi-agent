import { useId, useMemo, useState, type ReactNode } from "react";
import { ContextMeter, formatTokenCount, useComposerPopover } from "./ComposerControls";
import { MenuSurface } from "./MenuSurface";
import { IconDatabaseOutlineRegular, IconGaugeOutlineRegular } from "./vendor/harness-icons";
import { uiText as t } from "./i18n";
import type { ContextStatus, DurableEvent } from "./types";
import type { RunSummary } from "./projection";
import { sessionUsage } from "./session-usage";

function Stat({ kind, label, title, icon, children }: {
  kind: string; label: string; title: string; icon: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, () => setOpen(false), false);
  const id = useId();
  return <div className="composer-stat" data-composer-stat={kind} ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button className="composer-stat-trigger" ref={popover.trigger} type="button" aria-label={label} title={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      {icon}<span>{label}</span>
    </button>
    {open && <MenuSurface ref={popover.panel} id={id} role="dialog" aria-label={title} className="composer-popover composer-stat-popover">
      <strong>{title}</strong>{children}
    </MenuSurface>}
  </div>;
}

export function ComposerStats({ summary, events, context, capacity, active }: {
  summary: RunSummary; events: readonly DurableEvent[]; context: ContextStatus | null; capacity?: number; active: boolean;
}) {
  const usage = useMemo(() => sessionUsage(events), [events]);
  const exact = (value: number) => value.toLocaleString("en-US");
  const total = `${usage.unknown ? t("已知") + " " : ""}${formatTokenCount(usage.total)} tok`;
  const usageLabel = usage.cachePercent === null ? total : `${total} · ${t("缓存命中 {0}%", usage.cachePercent)}`;
  return <div className="session-run-summary" aria-label={t("会话统计")}>
    {summary.steps > 0 && <Stat kind="activity" label={t("{0} 轮 {1} 步", summary.turns, summary.steps)} title={t("运行统计")} icon={<IconGaugeOutlineRegular />}>
      <dl><dt>{t("轮次")}</dt><dd>{summary.turns}</dd><dt>{t("步数")}</dt><dd>{summary.steps}</dd>
        <dt>{t("工具调用")}</dt><dd>{summary.calls}</dd>
        <dt>{t("工具累计耗时")}</dt><dd>{(summary.durationMs / 1000).toFixed(1)}s</dd>
        {usage.durationMs > 0 && <><dt>{t("模型请求耗时")}</dt><dd>{(usage.durationMs / 1000).toFixed(1)}s</dd></>}
      </dl>
    </Stat>}
    {usage.requests > 0 && <Stat kind="usage" label={usage.total > 0 || usage.unknown === 0 ? usageLabel : t("用量未知")} title={t("会话用量")} icon={<IconDatabaseOutlineRegular />}>
      <dl><dt>{t("输入 tokens")}</dt><dd>{exact(usage.input)}</dd><dt>{t("输出 tokens")}</dt><dd>{exact(usage.output)}</dd>
        <dt>{t("缓存读取 tokens")}</dt><dd>{usage.cached === null ? t("未知") : exact(usage.cached)}</dd>
        <dt>{t("模型请求")}</dt><dd>{usage.requests}</dd>
      </dl>
      <p>{t("当前会话的逻辑请求用量，包含失败请求中已知的用量。")}</p>
      {usage.unknown > 0 && <p>{t("{0} 次请求用量未完整返回；以上仅为已知小计。", usage.unknown)}</p>}
    </Stat>}
    {!active && <ContextMeter status={context} capacity={capacity} />}
  </div>;
}
