// Fixed read-only probe evaluated only in the packaged main WKWebView.
// The native caller receives only these bounded fields. No cookie, credential,
// URL, response body, workspace name, or exception text is returned or logged.
(() => {
  const key = "__QI_NATIVE_AUTH_ACCEPTANCE_V2__";
  if (Object.prototype.hasOwnProperty.call(window, key)) return { ...window[key] };
  const snapshot = {
    schema: 1,
    complete: false,
    document_html: false,
    token_free_url: false,
    app_shell_visible: false,
    draft_view_visible: false,
    composer_visible_enabled: false,
    workspace_bound: false,
    bootstrap_status: 0,
    bootstrap_ok: false,
    bootstrap_shape: false,
    no_sessions: false,
    probe_error: false,
  };
  Object.defineProperty(window, key, { value: snapshot, configurable: false });
  const started = performance.now();
  let activeWorkspace = null;
  let fetched = false;
  const visible = element => {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return !element.hidden && style.display !== "none" && style.visibility !== "hidden"
      && style.opacity !== "0" && box.width > 0 && box.height > 0
      && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
  };
  const observe = () => {
    try {
      snapshot.document_html = document.contentType === "text/html";
      snapshot.token_free_url = location.protocol === "http:"
        && location.hostname === "127.0.0.1" && location.port.length > 0
        && location.pathname === "/" && location.search.length === 0;
      const root = document.getElementById("root");
      const shell = root?.querySelector(".app-shell");
      const draft = shell?.querySelector(".main-panel .new-session-view");
      const composer = draft?.querySelector(".composer-editor textarea");
      const workspace = draft?.querySelector("button.workspace-context-select");
      snapshot.app_shell_visible = visible(root) && visible(shell);
      snapshot.draft_view_visible = visible(draft);
      snapshot.composer_visible_enabled = visible(composer)
        && composer instanceof HTMLTextAreaElement && !composer.disabled && !composer.readOnly;
      const route = new URLSearchParams(location.hash.slice(1));
      snapshot.workspace_bound = !!activeWorkspace && visible(workspace)
        && route.get("workspace") === activeWorkspace.id && !route.has("session")
        && workspace.querySelector("span")?.textContent === activeWorkspace.name;
      if (fetched && (!snapshot.bootstrap_ok || !snapshot.bootstrap_shape || !snapshot.no_sessions
        || (snapshot.document_html && snapshot.token_free_url && snapshot.app_shell_visible
          && snapshot.draft_view_visible && snapshot.composer_visible_enabled && snapshot.workspace_bound))) {
        snapshot.complete = true;
      }
      if (performance.now() - started >= 20_000) snapshot.complete = true;
    } catch {
      snapshot.probe_error = true;
      snapshot.complete = true;
    }
    if (!snapshot.complete) setTimeout(observe, 100);
  };
  // Refuse to make a request from the Tauri bootstrap or token landing page.
  // A navigation creates a new document and receives a separate probe.
  if (location.protocol === "http:" && location.hostname === "127.0.0.1"
    && location.port.length > 0 && location.pathname === "/" && location.search.length === 0) {
    void (async () => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 8_000);
      try {
        const response = await fetch("/api/bootstrap", {
          method: "GET", credentials: "same-origin", cache: "no-store",
          redirect: "error", signal: abort.signal,
        });
        snapshot.bootstrap_status = response.status;
        const body = await response.json();
        snapshot.bootstrap_ok = response.status === 200 && body?.ok === true;
        const data = body?.result;
        const workspaces = data?.workspaces;
        const catalogs = data?.catalogs;
        const shape = Array.isArray(workspaces) && workspaces.length > 0
          && workspaces.every(item => item && typeof item.id === "string" && item.id.length > 0
            && typeof item.name === "string" && item.name.length > 0)
          && new Set(workspaces.map(item => item.id)).size === workspaces.length
          && typeof data.activeWorkspaceId === "string"
          && workspaces.some(item => item.id === data.activeWorkspaceId)
          && Array.isArray(catalogs) && catalogs.length === workspaces.length
          && new Set(catalogs.map(item => item?.workspaceId)).size === workspaces.length
          && catalogs.every(item => item && workspaces.some(workspace => workspace.id === item.workspaceId)
            && Array.isArray(item.sessions));
        snapshot.bootstrap_shape = shape;
        snapshot.no_sessions = shape && catalogs.every(item => item.sessions.length === 0);
        if (snapshot.bootstrap_ok && shape) {
          const selected = workspaces.find(item => item.id === data.activeWorkspaceId);
          activeWorkspace = { id: selected.id, name: selected.name };
        }
      } catch {
        snapshot.probe_error = true;
      } finally {
        clearTimeout(timer);
        fetched = true;
      }
    })();
  }
  observe();
  return { ...snapshot };
})();
