import { shortcutActions, type ShortcutAction, type ShortcutBinding } from "./web-preferences";

export const shortcutLabels: Record<ShortcutAction, string> = {
  shortcuts: "快捷键速查", "new-session": "新会话", sidebar: "切换侧边栏", "session-search": "搜索会话", "workspace-add": "添加工作区",
  settings: "打开设置", composer: "聚焦输入框", files: "文件与变更", details: "会话信息", chat: "对话", trajectory: "轨迹",
};
export function describeShortcut(binding: ShortcutBinding | null): string {
  const punctuation: Record<string, string> = { Slash: "/", Backslash: "\\", Comma: ",", Period: ".", BracketLeft: "[", BracketRight: "]" };
  return !binding ? "" : `${binding.primary ? "Ctrl/Cmd + " : ""}${binding.alt ? "Alt/Option + " : ""}${binding.shift ? "Shift + " : ""}${punctuation[binding.code] || binding.code.replace(/^Key|^Digit/, "")}`;
}
export type ShortcutContext = { workspace: boolean; session: boolean; busy: boolean; codeView: boolean };
export function shortcutAvailable(action: ShortcutAction, context: ShortcutContext): boolean {
  if (["details", "chat", "trajectory"].includes(action) && !context.session) return false;
  if (action === "trajectory" && !context.codeView) return false;
  if (["new-session", "composer", "files", "session-search"].includes(action) && !context.workspace) return false;
  return action !== "new-session" || !context.busy;
}
export const shortcutCatalog = shortcutActions.map(id => ({ id, label: shortcutLabels[id] }));
