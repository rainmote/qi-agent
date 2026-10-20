import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { relativeWorkspacePath, WorkspaceLink, WorkspaceLinkProvider } from "./WorkspaceLinks";
import { defaultShortcuts, getWebPreferences, normalizeWebPreferences, preferenceKey, saveShortcuts, updateWebPreferences } from "./web-preferences";
import { shortcutAvailable, shortcutCatalog } from "./shortcut-catalog";

test("workspace links resolve within the selected workspace and never interpret absolute URLs as file paths", () => {
  assert.equal(relativeWorkspacePath("./note.md"), "note.md");
  assert.equal(relativeWorkspacePath("../guide%20one.md#section", "docs/nested"), "docs/guide one.md");
  assert.equal(relativeWorkspacePath("../note.md", "docs"), "note.md");
  for (const href of ["../private", "../../private", "/etc/passwd", "//example.org", "https://example.org/x", "file:///etc/passwd", "javascript:alert(1)", "%2fetc/passwd", "%2e%2e/private", "a%5cb", "a%00b", "%zz", "#heading", "?query"]) {
    assert.equal(relativeWorkspacePath(href), null, href);
  }
  const link = renderToStaticMarkup(<WorkspaceLinkProvider value={{ workspaceId: "selected", open: () => assert.fail("server rendering must not open a file"), contentUrl: (workspace, path) => `/api/${workspace}/content?path=${encodeURIComponent(path)}` }}>
    <WorkspaceLink href="docs/note.md">文件原文</WorkspaceLink><WorkspaceLink href="https://example.org">website</WorkspaceLink><WorkspaceLink href="//example.org/path">relative protocol</WorkspaceLink><WorkspaceLink href="../outside">outside</WorkspaceLink>
  </WorkspaceLinkProvider>);
  assert.match(link, /href="\/api\/selected\/content\?path=docs%2Fnote.md"/);
  assert.match(link, /href="https:\/\/example.org" target="_blank" rel="noreferrer noopener"/);
  assert.match(link, /<span>outside<\/span>/);
  assert.match(link, /href="\/\/example.org\/path" target="_blank" rel="noreferrer noopener"/);
});

test("catalog contains only implemented navigation operations and availability follows the current view", () => {
  assert.equal(shortcutCatalog.length, 11);
  const empty = { workspace: false, session: false, busy: false, codeView: false };
  assert.equal(shortcutAvailable("files", empty), false);
  assert.equal(shortcutAvailable("workspace-add", empty), true);
  assert.equal(shortcutAvailable("trajectory", { ...empty, workspace: true, session: true }), false);
  assert.equal(shortcutAvailable("new-session", { ...empty, workspace: true, busy: true }), false);
  assert.equal(shortcutAvailable("chat", { ...empty, workspace: true, session: true }), true);
  const migrated = normalizeWebPreferences({ shortcuts: { files: null }, locale: "en" });
  assert.equal(migrated.shortcuts.files, null);
  assert.deepEqual(migrated.shortcuts.shortcuts, defaultShortcuts.shortcuts);
  assert.equal(migrated.fileLinkOpening, "panel");
  assert.equal(migrated.shortcutsRevision, 0);
  const oldCustom = normalizeWebPreferences({ shortcuts: { files: { code: "Slash", primary: true, alt: false, shift: false } } });
  assert.equal(oldCustom.shortcuts.files?.code, "Slash", "an old custom binding survives new default shortcuts");
  assert.equal(oldCustom.shortcuts.shortcuts, null, "a new default must yield to the persisted binding");
});

test("shortcut saves preserve accepted bindings on failure and require review after stale storage, including reset", () => {
  const before = getWebPreferences(), descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  let failWrite = false;
  try {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => { if (failWrite) throw Error("quota"); storage.set(key, value); },
    } });
    updateWebPreferences({ shortcuts: defaultShortcuts });
    const accepted = getWebPreferences(), revision = accepted.shortcutsRevision;
    const draft = { ...accepted.shortcuts, files: { code: "KeyG", primary: false, alt: true, shift: true } };
    failWrite = true;
    assert.equal(saveShortcuts(draft, revision), "failed");
    assert.deepEqual(getWebPreferences().shortcuts, accepted.shortcuts);
    failWrite = false;
    assert.equal(saveShortcuts(draft, revision), "saved");
    assert.equal(getWebPreferences().shortcuts.files?.code, "KeyG");
    storage.set(preferenceKey, JSON.stringify({ ...getWebPreferences(), locale: "en", fileLinkOpening: "new-tab" }));
    assert.equal(saveShortcuts(draft, revision + 1), "saved");
    assert.equal(getWebPreferences().locale, "en", "latest persisted unrelated preferences win even before their storage event arrives");
    assert.equal(getWebPreferences().fileLinkOpening, "new-tab");
    const newer = { ...getWebPreferences(), shortcutsRevision: revision + 3, shortcuts: { ...draft, files: null } };
    storage.set(preferenceKey, JSON.stringify(newer));
    assert.equal(saveShortcuts(defaultShortcuts, revision + 2), "stale");
    assert.equal(getWebPreferences().shortcuts.files, null);
    assert.equal(saveShortcuts(defaultShortcuts, revision + 3), "saved");
    storage.delete(preferenceKey);
    assert.equal(saveShortcuts(draft, revision + 4), "stale");
    assert.equal(getWebPreferences().shortcutsRevision, 0, "cleared storage can be reviewed rather than leaving an unrecoverable stale state");
    assert.equal(saveShortcuts(draft, 0), "saved");
    const externalShortcut = { ...getWebPreferences(), shortcutsRevision: 2, shortcuts: { ...draft, files: null } };
    storage.set(preferenceKey, JSON.stringify(externalShortcut));
    updateWebPreferences({ locale: "zh" });
    assert.equal(getWebPreferences().shortcuts.files, null, "general preferences must not overwrite a newer stored shortcut before its storage event");
    assert.equal(getWebPreferences().shortcutsRevision, 2);
  } finally {
    failWrite = false; updateWebPreferences(before);
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
