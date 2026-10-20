// Interaction structure follows Harness 687f282 (MIT); qi's available actions and approval boundary are retained.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DialogFrame } from "./Dialogs";
import { Icon } from "./icons";
import { uiText as t } from "./i18n";
import { defaultShortcuts, saveShortcuts, shortcutForEvent, shortcutIdentity, useWebPreferences, validShortcut, type ShortcutAction, type ShortcutBinding } from "./web-preferences";
import { describeShortcut, shortcutAvailable, shortcutCatalog, type ShortcutContext } from "./shortcut-catalog";

const displayBinding = (binding: ShortcutBinding | null) => describeShortcut(binding)
  .replace("Ctrl/Cmd + ", typeof navigator !== "undefined" && /Mac/.test(navigator.platform) ? "⌘ " : "Ctrl ")
  .replace("Alt/Option + ", "⌥ ").replace("Shift + ", "⇧ ");

export function ShortcutReference({ onClose, context }: { onClose: () => void; context: ShortcutContext }) {
  const prefs = useWebPreferences();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<ShortcutAction | null>(null);
  const [recording, setRecording] = useState(false), [candidate, setCandidate] = useState<ShortcutBinding | null>(null);
  const [reviewedRevision, setReviewedRevision] = useState(prefs.shortcutsRevision);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const recorder = useRef<HTMLButtonElement>(null), pending = useRef<ShortcutBinding | null>(null);
  const returnToRow = useRef<ShortcutAction | null>(null);
  const searchInput = useRef<HTMLInputElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const rows = useRef(new Map<ShortcutAction, HTMLButtonElement>()), resetButton = useRef<HTMLButtonElement>(null);
  const stale = reviewedRevision !== prefs.shortcutsRevision;
  const modified = shortcutCatalog.filter(({ id }) => {
    const a = prefs.shortcuts[id], b = defaultShortcuts[id];
    return a && b ? shortcutIdentity(a) !== shortcutIdentity(b) : a !== b;
  }).length;
  const cancelCapture = () => { pending.current = null; setRecording(false); };
  useEffect(() => { window.addEventListener("blur", cancelCapture); return () => window.removeEventListener("blur", cancelCapture); }, []);
  useLayoutEffect(() => {
    if (editing) recorder.current?.focus();
    else if (returnToRow.current) { rows.current.get(returnToRow.current)?.focus(); returnToRow.current = null; }
  }, [editing]);
  const closeEditor = (restoreFocus = true) => {
    returnToRow.current = restoreFocus ? editing : null; cancelCapture(); setEditing(null); setCandidate(null); setError("");
  };
  const focusStable = () => { if (window.matchMedia("(max-width:600px)").matches) heading.current?.focus(); else searchInput.current?.focus(); };
  const dismiss = () => {
    if (recording) { cancelCapture(); return; }
    if (confirmReset) { setConfirmReset(false); requestAnimationFrame(() => resetButton.current?.focus()); return; }
    if (editing) { closeEditor(); return; }
    onClose();
  };
  const edit = (id: ShortcutAction) => {
    pending.current = null; setEditing(id); setRecording(true); setCandidate(null); setError(""); setReviewedRevision(prefs.shortcutsRevision);
  };
  const save = (id: ShortcutAction, binding: ShortcutBinding | null, revision = reviewedRevision) => {
    if (binding && shortcutCatalog.some(row => row.id !== id && prefs.shortcuts[row.id] && shortcutIdentity(prefs.shortcuts[row.id]!) === shortcutIdentity(binding))) {
      setError("此组合已绑定其他操作，请先清除原绑定"); return;
    }
    const result = saveShortcuts({ ...prefs.shortcuts, [id]: binding }, revision);
    if (result === "saved") closeEditor();
    else setError(result === "stale" ? "快捷键配置已变化，请查看最新绑定后重试" : "无法保存快捷键，原绑定和草稿已保留，请重试");
  };
  const fixed = [
    { id: "send", group: "消息输入", label: prefs.busyEnter === "steer" ? "运行时插话发送" : "运行时排队发送", keys: "Enter" },
    { id: "newline", group: "消息输入", label: "换行", keys: "Shift + Enter" },
    { id: "complement", group: "消息输入", label: prefs.busyEnter === "steer" ? "运行时排队发送" : "运行时插话发送", keys: "Ctrl/Cmd + Enter" },
    { id: "commands", group: "消息输入", label: "命令建议", keys: "/" },
    { id: "references", group: "消息输入", label: "文件和会话引用", keys: "@" },
    { id: "move", group: "菜单与弹层", label: "移动菜单选择", keys: "↑ / ↓ / Home / End" },
    { id: "select", group: "菜单与弹层", label: "选择菜单项", keys: "Enter / Space" },
    { id: "dismiss", group: "菜单与弹层", label: "关闭菜单或顶层弹窗", keys: "Esc" },
    { id: "approval", group: "审批区域", label: "聚焦并选择明确的审批按钮", keys: "Tab → Enter / Space" },
  ];
  const match = (value: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const editable = shortcutCatalog.filter(row => match(`${row.id} ${t(row.label)} ${describeShortcut(prefs.shortcuts[row.id])}`));
  const fixedRows = fixed.filter(row => match(`${row.id} ${t(row.label)} ${t(row.group)} ${row.keys}`));
  return <DialogFrame title={t("快捷键")} className="shortcuts-dialog" onClose={dismiss}
    initialFocus={typeof window !== "undefined" && window.matchMedia("(max-width:600px)").matches ? "[data-shortcut-heading]" : "[data-shortcut-search]"}>
    <div className="shortcut-reference-body" onKeyDown={event => {
      if (event.target === recorder.current || event.defaultPrevented) return;
      if (shortcutForEvent(event.nativeEvent, prefs.shortcuts) === "shortcuts") { event.preventDefault(); event.stopPropagation(); dismiss(); }
    }}>
      <h2 ref={heading} data-shortcut-heading tabIndex={-1} className="sr-only">{t("快捷键速查")}</h2>
      <div className="shortcut-search"><Icon name="search" /><input ref={searchInput} data-shortcut-search type="search" aria-label={t("搜索快捷键")} placeholder={t("搜索快捷键")}
        value={query} onChange={event => { if (editing) closeEditor(false); setQuery(event.target.value); }} /></div>
      {confirmReset ? <section className="shortcut-reset-confirm" aria-label={t("恢复所有默认快捷键？")}>
        <h3>{t("恢复所有默认快捷键？")}</h3><p>{t("当前浏览器的修改和清除操作将被恢复，其他浏览器不受影响")}</p>
        <div><button type="button" onClick={() => { setConfirmReset(false); resetButton.current?.focus(); }}>{t("取消")}</button>
          <button type="button" onClick={() => { const result = saveShortcuts(defaultShortcuts, reviewedRevision); if (result === "saved") { setConfirmReset(false); setError(""); focusStable(); } else setError(result === "stale" ? "快捷键配置已变化，请查看最新绑定后重试" : "无法保存快捷键，原绑定和草稿已保留，请重试"); }}>{t("恢复默认快捷键")}</button></div>
        {error && <p role="alert">{t(error)}</p>}
        {stale && <button type="button" onClick={() => { setReviewedRevision(prefs.shortcutsRevision); setError(""); }}>{t("我已查看最新配置")}</button>}
      </section> : <div className="shortcut-reference-list">
        <section aria-label={t("应用操作")}><h3>{t("应用操作")}</h3>
          {editable.map(row => <div key={row.id} className={`shortcut-reference-row ${editing === row.id ? "is-editing" : ""}`}>
            <div><span>{t(row.label)}</span>{!shortcutAvailable(row.id, context) && <small>{t("当前页面暂不可用")}</small>}</div>
            {editing !== row.id ? <button ref={el => { if (el) rows.current.set(row.id, el); else rows.current.delete(row.id); }} type="button"
              className="shortcut-binding" aria-label={t("修改{0}快捷键", t(row.label))} onClick={() => edit(row.id)}>
              <kbd>{displayBinding(prefs.shortcuts[row.id]) || t("未绑定")}</kbd><Icon name="edit" /></button>
              : <div className="shortcut-inline-editor" role="group" aria-label={t(row.label)}>
                <div className="shortcut-inline-actions"><button type="button" disabled={stale} onClick={() => save(row.id, defaultShortcuts[row.id])}>{t("恢复默认")}</button>
                  <button type="button" disabled={stale} onClick={() => save(row.id, null)}>{t("清除")}</button>
                  <button ref={recorder} type="button" className="shortcut-recorder" aria-label={t("录制快捷键：{0}", t(row.label))} aria-pressed={recording}
                    onClick={() => { setRecording(true); pending.current = null; setCandidate(null); setError(""); }} onBlur={cancelCapture}
                    onCompositionStart={cancelCapture} onKeyDown={event => {
                      if (event.repeat) return;
                      if (!recording || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.getModifierState("AltGraph") || event.key === "Dead") { pending.current = null; return; }
                      if (event.key === "Tab") { cancelCapture(); return; }
                      event.preventDefault(); event.stopPropagation();
                      if (event.key === "Escape") { cancelCapture(); return; }
                      if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
                      const binding = { code: event.code, primary: event.ctrlKey || event.metaKey, alt: event.altKey, shift: event.shiftKey };
                      if ((event.ctrlKey && event.metaKey) || !validShortcut(binding)) { pending.current = null; setError("此组合不可用，请选择带修饰键的其他组合"); return; }
                      pending.current = binding; setCandidate(binding); setError("");
                    }} onKeyUp={event => {
                      const binding = pending.current;
                      if (!binding || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                      if (event.code !== binding.code && !/^(Meta|Control|Alt|Shift)(Left|Right)$/.test(event.code)) return;
                      event.preventDefault(); event.stopPropagation(); pending.current = null; setRecording(false); save(row.id, binding);
                    }}>{candidate ? describeShortcut(candidate) : t("请按组合键…")}</button></div>
                <small>{t("松开组合键保存；Tab 切换操作，Esc 取消录制")}</small>
                {(error || stale) && <p role="alert">{t(stale ? "快捷键配置已变化，请查看最新绑定后重试" : error)}</p>}
                {stale && <button type="button" onClick={() => { setReviewedRevision(prefs.shortcutsRevision); setError(""); }}>{t("我已查看最新配置")}</button>}
                {candidate && error && !stale && <button type="button" onClick={() => save(row.id, candidate)}>{t("重试保存")}</button>}
                <button type="button" onClick={() => closeEditor()}>{t("返回")}</button>
              </div>}
          </div>)}
        </section>
        {["消息输入", "菜单与弹层", "审批区域"].map(group => {
          const entries = fixedRows.filter(row => row.group === group); if (!entries.length) return null;
          return <section key={group} aria-label={t(group)}><h3>{t(group)}</h3>{entries.map(row => <div key={row.id} className="shortcut-reference-row"><span>{t(row.label)}</span><kbd>{row.keys}</kbd></div>)}</section>;
        })}
        {!editable.length && !fixedRows.length && <p role="status">{t("没有匹配的快捷键")}</p>}
        <p className="shortcut-context-note">{t("空闲时 Enter 正常发送；固定操作只在对应输入框、菜单或已聚焦按钮内生效")}</p>
      </div>}
      <footer><button ref={resetButton} type="button" disabled={!modified} onClick={() => { setEditing(null); cancelCapture(); setError(""); setReviewedRevision(prefs.shortcutsRevision); setConfirmReset(true); }}>{t("恢复默认快捷键")}</button><span>{t("{0} 项已修改", modified)}</span></footer>
    </div>
  </DialogFrame>;
}
