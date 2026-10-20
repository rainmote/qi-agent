import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { MenuSurface } from "./MenuSurface";
import { useComposerPopover } from "./ComposerControls";
import { uiText as t } from "./i18n";
import { normalizeFontFamily, updateWebPreferences, usePreferencePersistenceFailed, useWebPreferences,
  type FontRole, type WebPreferences } from "./web-preferences";

export function SettingsPreferenceControl<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const popover = useComposerPopover(open, () => setOpen(false), true, "below", true);
  return <div className="settings-preference-control" ref={popover.root} onKeyDown={popover.onKeyDown}>
    <button ref={popover.trigger} type="button" className="settings-preference-trigger" aria-label={label}
      aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {t(options.find(item => item.id === value)?.label || "")}<Icon name="chevronDown" />
    </button>
    {open && <MenuSurface ref={popover.panel} className="composer-popover settings-preference-menu" role="menu" aria-label={label}>
      {options.map(item => <button type="button" key={item.id} role="menuitemradio" aria-checked={item.id === value}
        onClick={() => { popover.dismiss(); onChange(item.id); }}><span>{t(item.label)}</span>{item.id === value && <Icon name="check" />}</button>)}
    </MenuSurface>}
  </div>;
}

function usePreferenceWriter() {
  const failed = usePreferencePersistenceFailed();
  return { failed, save: (patch: Partial<WebPreferences>) => { updateWebPreferences(patch); } };
}
function RoleFontField({ role, label, description }: { role: FontRole; label: string; description: string }) {
  const prefs = useWebPreferences();
  const [draft, setDraft] = useState(prefs.fontFamilies[role]);
  const [invalid, setInvalid] = useState(false);
  const { failed, save } = usePreferenceWriter();
  useEffect(() => { setDraft(prefs.fontFamilies[role]); }, [prefs.fontFamilies[role]]);
  const commit = () => {
    const value = normalizeFontFamily(draft);
    setInvalid(value === null);
    if (value === null) { setDraft(prefs.fontFamilies[role]); return; }
    setDraft(value); save({ fontFamilies: { ...prefs.fontFamilies, [role]: value } });
  };
  return <section className="settings-option-row settings-font-row"><div><h3>{t(label)}</h3><p>{t(description)}</p>
    {(invalid || failed) && <p role="alert">{invalid ? t("字体名称格式无效，已保留原设置") : t("当前浏览器未能保存偏好；刷新后可能恢复原值")}</p>}</div>
    <input type="text" aria-label={t(label)} placeholder={t("默认")} maxLength={200} spellCheck={false} autoComplete="off"
      value={draft} aria-invalid={invalid || undefined} onChange={event => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={event => { if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229 && event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
  </section>;
}
function RoleFontSize({ role, label }: { role: "code" | "terminal"; label: string }) {
  const prefs = useWebPreferences();
  const key = role === "code" ? "codeFontSize" : "terminalFontSize", value = prefs[key], max = role === "code" ? 16 : 20;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const apply = (input: string) => { const n = Number(input); if (Number.isInteger(n) && n >= 10 && n <= max) updateWebPreferences({ [key]: n }); };
  return <section className="settings-option-row"><div><h3>{t(label)}</h3></div><label className="role-font-size">
    <input type="number" aria-label={t(label)} min={10} max={max} value={draft} onChange={event => { setDraft(event.target.value); apply(event.target.value); }}
      onBlur={() => setDraft(String(value))} /><span>px</span></label></section>;
}
export function FontPreferences() {
  return <>
    <RoleFontField role="text" label={t("正文字体")} description={t("用于界面与会话正文。多个字体用逗号分隔，留空使用默认字体")} />
    <RoleFontField role="code" label={t("代码字体")} description={t("用于代码块、行内代码与工具参数。留空使用默认字体")} />
    <RoleFontSize role="code" label={t("代码字号")} />
    <RoleFontField role="terminal" label={t("终端输出字体")} description={t("用于命令输出。留空使用默认字体")} />
    <RoleFontSize role="terminal" label={t("终端输出字号")} />
  </>;
}
export function WebPreferenceRows({ onOpenShortcuts }: { onOpenShortcuts?: () => void }) {
  const prefs = useWebPreferences();
  const { failed, save } = usePreferenceWriter();
  return <>
    <section className="settings-option-row"><div><h3>{t("显示代码工作视图")}</h3><p>{t("开启后，显示轨迹与本轮文件差异")}</p></div>
      <button type="button" role="switch" className="settings-switch" aria-label={t("显示代码工作视图")} aria-checked={prefs.codeView}
        onClick={() => save({ codeView: !prefs.codeView })}><span /></button></section>
    <section className="settings-option-row settings-preference-row"><div><h3>{t("快捷键")}</h3><p>{t("查看和编辑当前可用的快捷键和输入操作")}</p></div>
      <button type="button" data-shortcuts-trigger className="settings-preference-trigger" onClick={onOpenShortcuts}>{t("编辑快捷键")}</button></section>
    <section className="settings-option-row settings-preference-row"><div><h3>{t("繁忙时的发送行为")}</h3><p>{t("智能体运行时 Enter 键和发送按钮的行为；Cmd/Ctrl+Enter 使用另一行为")}</p></div>
      <SettingsPreferenceControl label={t("繁忙时的发送行为")} value={prefs.busyEnter} options={[{ id: "queue", label: t("排队发送") }, { id: "steer", label: t("插话发送") }]}
        onChange={value => save({ busyEnter: value })} /></section>
    <section className="settings-option-row settings-preference-row"><div><h3>{t("文件链接打开方式")}</h3><p>{t("工作区内的相对文件链接；新标签页由浏览器决定预览或下载，外部网页另开标签")}</p></div>
      <SettingsPreferenceControl label={t("文件链接打开方式")} value={prefs.fileLinkOpening} options={[{ id: "panel", label: t("文件侧栏") }, { id: "new-tab", label: t("新标签页") }]}
        onChange={value => save({ fileLinkOpening: value })} /></section>
    {failed && <p role="alert">{t("当前浏览器未能保存偏好；刷新后可能恢复原值")}</p>}
  </>;
}
