import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { useWebPreferences } from "./web-preferences";

type LinkContext = { workspaceId: string; open: (path: string) => void; contentUrl: (workspace: string, path: string) => string };
const WorkspaceLinks = createContext<LinkContext | null>(null);
export function WorkspaceLinkProvider({ value, children }: { value: LinkContext | null; children: ReactNode }) {
  return <WorkspaceLinks.Provider value={value}>{children}</WorkspaceLinks.Provider>;
}

/** Resolve only relative file paths. The Host remains authoritative for access and content. */
export function relativeWorkspacePath(href: string, directory = ""): string | null {
  if (!href || /^[\s/\\#?]|^[a-z][a-z\d+.-]*:/i.test(href) || /[\x00-\x20\x7f\\]/.test(href)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!decoded || /^[\/\\]|^[a-z][a-z\d+.-]*:/i.test(decoded) || /[\x00-\x1f\x7f\\]/.test(decoded)) return null;
  const parts = directory.split("/").filter(Boolean);
  for (const part of decoded.split("/")) {
    if (part === "..") { if (!parts.length) return null; parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

export function WorkspaceLink({ href, directory, children, ...props }: ComponentProps<"a"> & { directory?: string }) {
  const context = useContext(WorkspaceLinks), preferences = useWebPreferences();
  const path = href ? relativeWorkspacePath(href, directory) : null;
  // A relative link without a workspace must not accidentally navigate the app route.
  const external = href && /^(?:https?:|mailto:|tel:|#|\/\/[^/\\\s])/i.test(href);
  if (!external && (!path || !context)) return <span>{children}</span>;
  return <a {...props} href={context && path ? context.contentUrl(context.workspaceId, path) : href} target="_blank" rel="noreferrer noopener"
    onClick={event => {
      props.onClick?.(event);
      if (!event.defaultPrevented && context && path && preferences.fileLinkOpening === "panel" && event.button === 0
        && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
        event.preventDefault(); context.open(path);
      }
    }}>{children}</a>;
}
