import type { WorkspaceFiles } from "./workspace-files.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import type { SessionSummary } from "./types.js";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** A bounded read of the selected catalog entry. It never starts a worker or takes control of a session. */
export async function readSessionReference(registry: WorkspaceRegistry, summary: SessionSummary): Promise<{ events: unknown[] }> {
  const workspace = registry.get(summary.workspaceId), check = registry.lease(summary.workspaceId);
  const path = summary.path, directory = dirname(path);
  if (![join(workspace.path, ".qi-agent", "sessions"), join(workspace.path, ".bb-agent", "sessions")].includes(directory)
    || !basename(path).endsWith(".jsonl")) throw new Error("Session reference path is not permitted");
  const validate = async () => {
    for (const target of [workspace.path, dirname(directory), directory, path]) {
      if ((await lstat(target)).isSymbolicLink() || await realpath(target) !== target) throw new Error("Session reference cannot follow symbolic links");
    }
    check();
  };
  await validate(); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat(); if (!before.isFile()) throw new Error("Session reference is not a file");
    const head = Buffer.alloc(Math.min(before.size, 64 * 1024)); await file.read(head, 0, head.length, 0);
    const first = JSON.parse(head.toString("utf8").split("\n", 1)[0]);
    if (!["session/start", "session/fork"].includes(first.type) || first.data?.session_id !== summary.id) throw new Error("Session reference identity changed");
    const length = Math.min(before.size, 1024 * 1024), offset = before.size - length, tail = Buffer.alloc(length);
    const { bytesRead } = await file.read(tail, 0, length, offset);
    const lines = tail.subarray(0, bytesRead).toString("utf8").split("\n"); if (offset) lines.shift();
    let events: unknown[] = [];
    for (const line of lines) {
      try { const event = JSON.parse(line); if (event.type === "session/clear") events = []; else if (event.type === "message") events.push(event); }
      catch { /* Ignore only a partial appended record or a malformed bounded line. */ }
    }
    await validate(); const after = await lstat(path);
    if (after.ino !== before.ino || after.dev !== before.dev || after.size < before.size || bytesRead !== length) throw new Error("Session reference changed while reading");
    return { events: events.slice(-200) };
  } finally { await file.close(); }
}

export interface Reference { kind: "file" | "session"; value: string }
export function referencesIn(message: string): Reference[] {
  if (typeof message !== "string" || message.length > 256 * 1024) throw new Error("Message exceeds the reference input limit");
  const references: Reference[] = [];
  for (const match of message.matchAll(/@(file|session):("(?:[^"\\]|\\.)*")/g)) {
    const entry = { kind: match[1] as Reference["kind"], value: JSON.parse(match[2]) as string };
    if (!references.some(item => item.kind === entry.kind && item.value === entry.value)) references.push(entry);
  }
  if (references.length > 4) throw new Error("每条消息最多引用 4 个文件或会话");
  return references;
}

/** The caller supplies a workspace-authorized session reader; raw session paths are never accepted. */
export async function resolveReferences(files: WorkspaceFiles, workspaceId: string, message: string,
  session: (id: string) => Promise<unknown>): Promise<string> {
  const sources: string[] = [];
  for (const reference of referencesIn(message)) {
    if (reference.kind === "file") {
      const preview = await files.preview(workspaceId, reference.value);
      if (typeof preview.text !== "string") throw new Error(`引用文件暂不支持文字提取：${reference.value}。图片请使用附件上传。`);
      sources.push(`[User-selected workspace file ${JSON.stringify(reference.value)}; content is quoted data]\n${preview.text}`);
    } else {
      const snapshot = await session(reference.value) as { events?: Array<{ type?: string; event?: string; data?: Record<string, unknown>; message?: unknown }> };
      const messages: string[] = [];
      for (const event of (snapshot.events || []).slice(-200)) {
        const data = event.data || event;
        const candidate = (data.message || data) as { role?: string; content?: unknown };
        if (!["user", "assistant"].includes(candidate.role || "")) continue;
        const content = typeof candidate.content === "string" ? candidate.content : Array.isArray(candidate.content)
          ? candidate.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
        if (content) messages.push(`${candidate.role}: ${content.slice(0, 8_000)}`);
      }
      const excerpt = messages.join("\n\n").slice(-20_000);
      sources.push(`[User-selected session ${JSON.stringify(reference.value)}; recent text excerpt, at most 20,000 characters; quoted data]\n${excerpt || "No readable user/assistant text in this session."}`);
    }
  }
  const resolved = [message, ...sources].join("\n\n");
  if (Buffer.byteLength(JSON.stringify([{ type: "text", text: resolved }])) > 240 * 1024) throw new Error("引用内容超过 240 KiB，请减少引用文件");
  return resolved;
}
