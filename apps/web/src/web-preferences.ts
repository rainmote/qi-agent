import { useSyncExternalStore } from "react";

export type WebLocale = "zh" | "en";
export type FontRole = "text" | "code" | "terminal";
export const shortcutActions = ["shortcuts", "new-session", "sidebar", "session-search", "workspace-add", "settings", "composer", "files", "details", "chat", "trajectory"] as const;
export type ShortcutAction = typeof shortcutActions[number];
export type ShortcutBinding = { code: string; primary: boolean; alt: boolean; shift: boolean };
export type WebPreferences = {
  locale: WebLocale; codeView: boolean; busyEnter: "queue" | "steer"; fileLinkOpening: "panel" | "new-tab"; shortcutsRevision: number;
  fontFamilies: Record<FontRole, string>; codeFontSize: number; terminalFontSize: number;
  shortcuts: Record<ShortcutAction, ShortcutBinding | null>;
};
export const preferenceKey = "qi-agent.web-preferences.v1";
const altShift = (code: string): ShortcutBinding => ({ code, primary: false, alt: true, shift: true });
export const defaultShortcuts: WebPreferences["shortcuts"] = {
  shortcuts: { code: "Slash", primary: true, alt: false, shift: false },
  "new-session": altShift("KeyN"), sidebar: altShift("KeyB"), settings: altShift("KeyS"), composer: altShift("KeyI"), files: altShift("KeyF"),
  "session-search": altShift("KeyK"), "workspace-add": altShift("KeyO"), details: altShift("KeyD"), chat: altShift("KeyJ"), trajectory: altShift("KeyT"),
};

export function normalizeFontFamily(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200 || /[;{}\\\x00-\x1f]|url\s*\(/i.test(value)) return null;
  const parts = value.split(",").map(part => part.trim().replace(/\s+/g, " ")).filter(Boolean);
  if (parts.some(part => !/^(?:[\p{L}\p{N}_ -]+|"[\p{L}\p{N}_ -]+"|'[\p{L}\p{N}_ -]+')$/u.test(part))) return null;
  return parts.join(", ");
}
export function validShortcut(value: unknown): value is ShortcutBinding {
  if (!value || typeof value !== "object") return false;
  const v = value as ShortcutBinding;
  if (!/^Key[A-Z]$|^Digit[0-9]$|^F(?:[1-9]|1[0-2])$|^(?:Slash|Backslash|Comma|Period|BracketLeft|BracketRight)$/.test(v.code)
    || typeof v.primary !== "boolean" || typeof v.alt !== "boolean" || typeof v.shift !== "boolean" || (!v.primary && !v.alt)) return false;
  // Keep native editing and browser navigation available even in the composer.
  return !(v.primary && /^(?:Key[ACVXYZQLRWTNFOHMSP]|Digit[0-9])$/.test(v.code)) && !(v.alt && v.code === "F4");
}
export function shortcutIdentity(value: ShortcutBinding): string {
  return `${value.primary ? "Mod+" : ""}${value.alt ? "Alt+" : ""}${value.shift ? "Shift+" : ""}${value.code}`;
}
export function normalizeWebPreferences(value: unknown): WebPreferences {
  const v = value && typeof value === "object" ? value as Partial<WebPreferences> : {};
  const shortcuts = Object.fromEntries(shortcutActions.map(action => [action, null])) as WebPreferences["shortcuts"];
  const seen = new Set<string>();
  // Existing explicit bindings win over defaults introduced by an upgrade.
  const explicit = shortcutActions.filter(action => validShortcut(v.shortcuts?.[action]));
  for (const action of [...explicit, ...shortcutActions.filter(action => !explicit.includes(action))]) {
    const candidate = v.shortcuts?.[action];
    const binding = candidate === null ? null : validShortcut(candidate) ? candidate : defaultShortcuts[action];
    if (binding) {
      const key = shortcutIdentity(binding);
      if (!seen.has(key)) { shortcuts[action] = { ...binding }; seen.add(key); }
    }
  }
  return { locale: v.locale === "en" ? "en" : "zh", codeView: v.codeView !== false,
    busyEnter: v.busyEnter === "steer" ? "steer" : "queue", fileLinkOpening: v.fileLinkOpening === "new-tab" ? "new-tab" : "panel", shortcuts,
    shortcutsRevision: Number.isSafeInteger(v.shortcutsRevision) && v.shortcutsRevision! >= 0 ? v.shortcutsRevision! : 0,
    fontFamilies: { text: normalizeFontFamily(v.fontFamilies?.text ?? "") ?? "", code: normalizeFontFamily(v.fontFamilies?.code ?? "") ?? "", terminal: normalizeFontFamily(v.fontFamilies?.terminal ?? "") ?? "" },
    codeFontSize: Number.isInteger(v.codeFontSize) && v.codeFontSize! >= 10 && v.codeFontSize! <= 16 ? v.codeFontSize! : 11,
    terminalFontSize: Number.isInteger(v.terminalFontSize) && v.terminalFontSize! >= 10 && v.terminalFontSize! <= 20 ? v.terminalFontSize! : 13 };
}
function loadPreferences(): WebPreferences {
  try { return normalizeWebPreferences(JSON.parse(localStorage.getItem(preferenceKey) || "null")); }
  catch { return normalizeWebPreferences(null); }
}
let current = loadPreferences();
let persistenceFailed = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
export const getWebPreferences = () => current;
export function updateWebPreferences(patch: Partial<WebPreferences>): boolean {
  let readFailed = false;
  if (!patch.shortcuts) {
    try {
      const stored = normalizeWebPreferences(JSON.parse(localStorage.getItem(preferenceKey) || "null"));
      current = { ...current, shortcuts: stored.shortcuts, shortcutsRevision: stored.shortcutsRevision };
    } catch { readFailed = true; }
  }
  current = normalizeWebPreferences({ ...current, ...patch, shortcutsRevision: patch.shortcuts ? current.shortcutsRevision + 1 : current.shortcutsRevision });
  let saved = true;
  try { if (readFailed) saved = false; else localStorage.setItem(preferenceKey, JSON.stringify(current)); } catch { saved = false; }
  persistenceFailed = !saved;
  listeners.forEach(listener => listener());
  return saved;
}
/** Shortcut edits keep the accepted binding on write failure and reject an already stale review. */
export function saveShortcuts(shortcuts: WebPreferences["shortcuts"], reviewedRevision: number): "saved" | "stale" | "failed" {
  let stored: WebPreferences;
  try { stored = normalizeWebPreferences(JSON.parse(localStorage.getItem(preferenceKey) || "null")); }
  catch { persistenceFailed = true; listeners.forEach(listener => listener()); return "failed"; }
  if (current.shortcutsRevision !== reviewedRevision || stored.shortcutsRevision !== reviewedRevision) {
    current = stored; persistenceFailed = false;
    listeners.forEach(listener => listener()); return "stale";
  }
  // Reconcile unrelated preferences from storage instead of overwriting a newer tab's values.
  const next = normalizeWebPreferences({ ...stored, shortcuts, shortcutsRevision: reviewedRevision + 1 });
  try { localStorage.setItem(preferenceKey, JSON.stringify(next)); }
  catch { persistenceFailed = true; listeners.forEach(listener => listener()); return "failed"; }
  current = next; persistenceFailed = false; listeners.forEach(listener => listener()); return "saved";
}
export function useWebPreferences(): WebPreferences {
  return useSyncExternalStore(subscribe, getWebPreferences, getWebPreferences);
}
export function usePreferencePersistenceFailed(): boolean {
  return useSyncExternalStore(subscribe, () => persistenceFailed, () => false);
}
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key !== preferenceKey && event.key !== null) return;
  current = loadPreferences(); persistenceFailed = false; listeners.forEach(listener => listener());
});

export function shortcutForEvent(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing" | "repeat">,
  shortcuts: WebPreferences["shortcuts"]): ShortcutAction | null {
  if (event.isComposing || event.repeat || (event.ctrlKey && event.metaKey)) return null;
  return shortcutActions.find(action => {
    const binding = shortcuts[action];
    return binding && binding.code === event.code && binding.primary === (event.ctrlKey || event.metaKey)
      && binding.alt === event.altKey && binding.shift === event.shiftKey;
  }) || null;
}
export function busySubmission(preferred: "queue" | "steer", running: boolean, complementary = false): "auto" | "queue" | "steer" {
  return !running ? "auto" : complementary ? preferred === "queue" ? "steer" : "queue" : preferred;
}
