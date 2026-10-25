import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { busySubmission, defaultShortcuts, getWebPreferences, normalizeFontFamily, normalizeWebPreferences, preferenceKey,
  shortcutForEvent, updateWebPreferences, validShortcut } from "./web-preferences";
import { uiText } from "./i18n";
import { english } from "./web-english";
import { SubagentPanel } from "./SubagentPanel";
import { outcomeText } from "./run-outcome";

test("font preferences reject CSS injection and invalid ranges while allowing installed family lists", () => {
  assert.equal(normalizeFontFamily('  "SF Mono" , Menlo , monospace  '), '"SF Mono", Menlo, monospace');
  assert.equal(normalizeFontFamily("思源黑体, sans-serif"), "思源黑体, sans-serif");
  assert.equal(normalizeFontFamily("   "), "");
  for (const value of ['Arial; color:red', 'url(https://example.invalid/font)', '"Arial"}body{', 'a\\b', 'a\nb', 'a'.repeat(201)]) assert.equal(normalizeFontFamily(value), null);
  const prefs = normalizeWebPreferences({ codeFontSize: 99, terminalFontSize: 9, locale: "invalid", fontFamilies: { text: "url(x)" } });
  assert.equal(prefs.codeFontSize, 13); assert.equal(prefs.terminalFontSize, 13); assert.equal(prefs.locale, "zh"); assert.equal(prefs.fontFamilies.text, "");
});

test("shortcut bindings reject browser reserved keys, duplicate actions and composition or held-key events", () => {
  assert.equal(validShortcut({ code: "KeyW", primary: true, alt: false, shift: true }), false);
  for (const code of ["KeyA", "KeyC", "KeyV", "KeyX", "KeyZ", "KeyY"]) assert.equal(validShortcut({ code, primary: true, alt: false, shift: false }), false);
  assert.equal(validShortcut({ code: "F4", primary: false, alt: true, shift: false }), false);
  assert.equal(validShortcut({ code: "KeyA", primary: false, alt: false, shift: true }), false);
  const prefs = normalizeWebPreferences({ shortcuts: { ...defaultShortcuts, files: defaultShortcuts.sidebar } });
  assert.equal(prefs.shortcuts.files, null);
  const event = { code: "KeyF", ctrlKey: false, metaKey: false, altKey: true, shiftKey: true, isComposing: false, repeat: false };
  assert.equal(shortcutForEvent(event, defaultShortcuts), "files");
  assert.equal(shortcutForEvent({ ...event, isComposing: true }, defaultShortcuts), null);
  assert.equal(shortcutForEvent({ ...event, repeat: true }, defaultShortcuts), null);
  assert.equal(shortcutForEvent({ ...event, metaKey: true, ctrlKey: true }, defaultShortcuts), null);
});

test("busy send preference and complementary modifier resolve only the existing running-turn modes", () => {
  for (const mode of ["queue", "steer"] as const) {
    assert.equal(busySubmission(mode, false), "auto"); assert.equal(busySubmission(mode, false, true), "auto");
    assert.equal(busySubmission(mode, true), mode);
    assert.equal(busySubmission(mode, true, true), mode === "queue" ? "steer" : "queue");
  }
});

test("local preferences report failed persistence without changing backend authority or losing in-memory state", () => {
  const before = getWebPreferences(), descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  try {
    const saved = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) || null, setItem: (key: string, value: string) => saved.set(key, value) } });
    assert.equal(updateWebPreferences({ locale: "en", codeView: false }), true);
    assert.equal(JSON.parse(saved.get(preferenceKey)!).locale, "en");
    assert.equal(Object.hasOwn(JSON.parse(saved.get(preferenceKey)!), "policy"), false);
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) || null, setItem: () => { throw Error("quota"); } } });
    assert.equal(updateWebPreferences({ busyEnter: "steer" }), false);
    assert.equal(getWebPreferences().busyEnter, "steer");
  } finally {
    updateWebPreferences(before);
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("English preserves interpolation placeholders and keeps user and model payloads verbatim", () => {
  const before = getWebPreferences();
  try {
    updateWebPreferences({ locale: "en" });
    assert.equal(uiText("运行命令"), "Run command"); assert.equal(uiText("对话"), "Chat");
    assert.equal(uiText("工作步骤 · {0} 项{1}", 3, " · raw内容"), "Work steps · 3 items · raw内容");
    for (const [source, translated] of Object.entries(english)) {
      assert.deepEqual([...source.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), [...translated.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), source);
    }
    const html = renderToStaticMarkup(<SubagentPanel jobs={[{ id: "x", label: "任务原文", provider: "mock", status: "completed", result: "模型原文：等待批准" }]} />);
    assert.match(html, /Completed · not yet verified/); assert.match(html, /任务原文/); assert.match(html, /模型原文：等待批准/);
    assert.match(outcomeText({ "run-id": "test", status: "uncertain", verification: "unknown", error: "原始错误" }), /Result unconfirmed · reconciliation needed · Verification result unknown · 原始错误/);
  } finally { updateWebPreferences(before); }
});
