import { useEffect, useRef, useState } from "react";
import { uiText as t } from "./i18n";
import type { ComputerUseStatus } from "./types";

export type ComputerCommand = "connect" | "disconnect" | "reconnect";

export function ComputerUsePanel({ status, onCommand, onRefresh }: {
  status?: ComputerUseStatus | null;
  onCommand?: (command: ComputerCommand) => Promise<void>;
  onRefresh?: () => Promise<void>;
}) {
  const lock = useRef(false), mounted = useRef(true);
  const [pending, setPending] = useState(false), [error, setError] = useState<string | null>(null);
  const [inspected, setInspected] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setInspected(false); }, [status?.uncertain, status?.connected]);
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(null);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t("操作失败")); }
    finally { lock.current = false; if (mounted.current) setPending(false); }
  };
  const labels = {
    disabled: "当前配置未启用", untrusted: "项目受限", "unsupported-world": "运行环境不支持桌面操作",
    uncertain: "上次操作结果未知", connected: "工具已连接", disconnected: "未连接",
  };
  const uncertain = Boolean(status?.uncertain);
  const canConnect = status?.enabled && status.trusted && status["local-desktop"] && status["image-model"];
  return <section className="computer-use-panel" aria-label={t("电脑操作")} aria-busy={pending}>
    <h4>{t("电脑操作")}</h4>
    <p role="status">{status ? `${status["configured-provider"]} · ${t(labels[status.state] || "状态未知")}` : t("当前会话未加载电脑操作插件")}</p>
    {status && <>
      <p>{status.capabilities?.surfaces?.includes("browser") ? t("Chrome 扩展模式（显式启用）") : t("原生电脑模式")}
        {" · "}{t("操作范围：本机桌面")}{" · "}{t("{0} 个模型工具", status.tools.length)}</p>
      {status.capabilities?.surfaces?.includes("browser") && <p>{t("Chrome 站点授权尚未接入，新站点请求会取消。")}</p>}
      {!status.enabled && <p>{t("需在新的会话运行配置中明确启用电脑操作；这里不会修改权限或安装软件。")}</p>}
      {status.enabled && !status.trusted && <p>{t("先查看项目信任范围；此处不会替你信任项目。")}</p>}
      {status.enabled && !status["local-desktop"] && <p>{t("仅支持明确配置为 local / sandbox:none 的运行环境。")}</p>}
      {status.enabled && !status["image-model"] && <p>{t("请选择支持图像输入的模型，再操作桌面。")}</p>}
      <p>{t("连接只验证工具发现。实际操作仍需系统权限和独立的应用审批。")}</p>
      {uncertain && <label className="computer-use-inspect"><input type="checkbox" checked={inspected} disabled={pending}
        onChange={event => setInspected(event.target.checked)} />{t("我已查看桌面并核对上次操作；重新连接不会重放输入。")}</label>}
      {status.error && <p role="alert">{status.error}</p>}
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="computer-use-actions">
      {status?.enabled && <button type="button" disabled={pending || !onCommand ||
        (status.connected ? false : !canConnect || (uncertain && !inspected))}
        onClick={() => { if (onCommand) void run(() => onCommand(status.connected ? "disconnect" : uncertain ? "reconnect" : "connect")); }}>
        {t(pending ? "正在处理…" : status.connected ? "断开电脑操作" : uncertain ? "核对后重新连接" : "连接电脑操作")}
      </button>}
      {onRefresh && <button type="button" disabled={pending} onClick={() => void run(onRefresh)}>{t("刷新状态")}</button>}
    </div>
  </section>;
}
