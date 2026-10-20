import { uiText as t } from "./i18n";
import { useEffect, useState } from "react";
import { PluginSlots, type PluginSlot } from "./PluginSlots";

export type PluginRpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type PackageInfo = {
  id: string; name: string; description: string; version: string; sha256: string;
  scope: "system" | "user"; "read-only": boolean; enabled: boolean; active: boolean;
  "restart-required": boolean; previous?: string; tools: string[];
  versions?: Array<{ version: string; sha256: string }>;
};

export function PluginPanel({ rpc, readOnly = false }: { rpc: PluginRpc; readOnly?: boolean }) {
  const [packages, setPackages] = useState<PackageInfo[]>([]);
  const [slots, setSlots] = useState<PluginSlot[]>([]);
  const [source, setSource] = useState("");
  const [sha256, setSha256] = useState("");
  const [commit, setCommit] = useState("");
  const [path, setPath] = useState("plugin.edn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const refresh = async () => {
    const [inventory, ui] = await Promise.all([
      rpc("plugins.list"), rpc("plugins.ui-slots"),
    ]) as [{ plugins: PackageInfo[]; diagnostics?: Record<string, string> }, { slots: PluginSlot[] }];
    setPackages(inventory.plugins); setSlots(ui.slots);
    const diagnostics = Object.entries(inventory.diagnostics || {});
    if (diagnostics.length) setNotice(diagnostics.map(([id, message]) => `${id}: ${message}`).join("；"));
  };
  useEffect(() => {
    let cancelled = false;
    Promise.all([rpc("plugins.list"), rpc("plugins.ui-slots")]).then(([inventory, ui]) => {
      if (cancelled) return;
      const result = inventory as { plugins: PackageInfo[]; diagnostics?: Record<string, string> };
      setPackages(result.plugins); setSlots((ui as { slots: PluginSlot[] }).slots);
      if (Object.keys(result.diagnostics || {}).length) setNotice(Object.entries(result.diagnostics || {})
        .map(([id, message]) => `${id}: ${message}`).join("；"));
    }).catch((value: unknown) => { if (!cancelled) setError(value instanceof Error ? value.message : t("插件读取失败")); });
    return () => { cancelled = true; };
  }, [rpc]);
  const mutate = async (params: Record<string, unknown>) => {
    if (readOnly || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await rpc("plugins.manage", params);
      setNotice(params.action === "install" ? t("安装完成。新插件默认停用，可审阅后启用。") : t("已更新当前会话。其他已打开的会话需重新启动才能同步。"));
      await refresh();
    } catch (value) { setError(value instanceof Error ? value.message : t("插件操作失败")); }
    finally { setBusy(false); }
  };
  const git = source.startsWith("git+https://");
  const remote = source.startsWith("https://") || git;
  const pinValid = /^[a-f0-9]{64}$/.test(sha256);
  return <section aria-label={t("插件管理")} style={{ display: "grid", gap: 16, minWidth: 0 }}>
    <div><h3 style={{ margin: "0 0 6px" }}>{t("插件与扩展")}</h3>
      <p style={{ margin: 0 }}>{t("从固定版本的插件包添加工具和面板。安装与启停由当前会话的审批规则控制。")}</p></div>
    {readOnly && <p role="status">{t("当前为观察模式，插件管理仅可查看。")}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void mutate({ action: "install", source: source.trim(),
      ...(sha256 ? { sha256 } : {}), ...(git ? { commit, path } : {}) }); }}
      style={{ display: "grid", gap: 8 }}>
      <label>{t("插件包位置")}<input style={{ width: "100%", boxSizing: "border-box" }} aria-label={t("插件包位置")}
        value={source} onChange={(event) => setSource(event.target.value)} placeholder={t("本地 .edn 文件、HTTPS 或 git+https:// 地址")}
        disabled={busy || readOnly} required /></label>
      <label>{t("SHA-256 完整性校验")}{remote ? t("（必填）") : t("（可选）")}
        <input aria-label={t("插件 SHA-256")} style={{ width: "100%", boxSizing: "border-box" }} value={sha256}
          onChange={(event) => setSha256(event.target.value.trim())} disabled={busy || readOnly} placeholder={t("64 位小写十六进制摘要")} /></label>
      {git && <><label>{t("固定提交")}<input aria-label={t("插件 Git 提交")} value={commit}
        onChange={(event) => setCommit(event.target.value.trim())} disabled={busy || readOnly} required /></label>
        <label>{t("包内路径")}<input aria-label={t("插件 Git 路径")} value={path} onChange={(event) => setPath(event.target.value)}
          disabled={busy || readOnly} required /></label></>}
      <button type="submit" className="button" disabled={readOnly || busy || !source.trim()
        || (remote && !pinValid) || (!!sha256 && !pinValid) || (git && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit))}>
        {busy ? t("处理中…") : t("安装插件包")}</button>
    </form>
    <div style={{ display: "grid", gap: 10 }}>
      {!packages.length && <p>{t("尚未安装插件包。")}</p>}
      {packages.map((entry) => <article key={entry.id} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <strong>{entry.name}</strong><span>{entry.version}</span>
          <small>{entry["read-only"] ? t("系统只读") : entry.active ? t("当前已启用") : entry.enabled ? t("下次启动生效") : t("已停用")}</small></div>
        <p style={{ overflowWrap: "anywhere" }}>{entry.description}</p>
        {entry["restart-required"] && <p>{t("该插件的保存状态与当前运行状态不同，需要重启会话。")}</p>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="button ghost compact-button" type="button" onClick={() => setSelected(selected === entry.id ? null : entry.id)}>{t("查看详情")}</button>
          {!entry["read-only"] && <><button className="button ghost compact-button" type="button" disabled={busy || readOnly}
            onClick={() => void mutate({ action: entry.enabled ? "disable" : "enable", id: entry.id })}>{entry.enabled ? t("停用") : t("启用")}</button>
            {entry.previous && <button className="button ghost compact-button" type="button" disabled={busy || readOnly}
              onClick={() => void mutate({ action: "rollback", id: entry.id })}>{t("回滚上一版本")}</button>}
            <button className="button ghost compact-button" type="button" disabled={busy || readOnly}
              onClick={() => void mutate({ action: "remove", id: entry.id })}>{t("移除")}</button></>}
        </div>
        {selected === entry.id && <div style={{ overflowWrap: "anywhere", marginTop: 12 }}>
          <p>ID：{entry.id}</p><p>{t("摘要：")}<code>{entry.sha256}</code></p>
          <p>{t("工具：")}{entry.tools.join("、") || t("无")}</p>
          <p>{t("保存版本：")}{entry.versions?.map((version) => version.version).join("、") || entry.version}</p>
          <small>{t("修改即时作用于当前会话，并保存供以后会话使用。其他运行中的会话需重启。移除后保留校验对象以便恢复。")}</small>
        </div>}
      </article>)}
    </div>
    <PluginSlots slots={slots} />
  </section>;
}
