import type { DurableEvent } from "./types";
import type { IconName } from "./icons";
import { uiText as t } from "./i18n";

// Harness's category order is frequency, then first occurrence, never a fixed priority.
// The explicit qi aliases below correspond to tools actually registered by this runtime.
export function processCategory(name: string): { label: string; icon: IconName } {
  if (["read", "read_file"].includes(name)) return { label: "读取文件", icon: "folderOpen" };
  if (name === "read_image") return { label: "读取图片", icon: "eye" };
  if (["grep", "glob", "find", "lsp_query"].includes(name) || name.endsWith("_inspect")) return { label: "搜索", icon: "search" };
  if (["write", "write_file"].includes(name)) return { label: "写入文件", icon: "folderEdit" };
  if (["edit", "edit_file", "apply_patch"].includes(name)) return { label: "编辑文件", icon: "edit" };
  if (["bash", "pwsh", "exec_command", "write_stdin", "terminal"].includes(name) || name.startsWith("terminal_")) return { label: "运行命令", icon: "terminal" };
  if (["run_code", "bb_repl"].includes(name)) return { label: "运行代码", icon: "command" };
  if (name === "web_search") return { label: "网页搜索", icon: "search" };
  if (name === "web_fetch") return { label: "网页读取", icon: "eye" };
  if (["subagent", "delegate_task", "fork_agent"].includes(name) || name.startsWith("subagent_")) return { label: "子任务", icon: "branch" };
  if (["todo_write", "create_goal", "update_goal", "get_goal"].includes(name)) return { label: "更新计划", icon: "activity" };
  if (["ask_user_question", "request_user_input"].includes(name)) return { label: "询问用户", icon: "bot" };
  return { label: "调用工具", icon: "plugin" };
}

const detailFields = ["title", "description", "objective", "task", "task_name", "name", "question", "questions",
  "prompt", "message", "queries", "query", "pattern", "url", "uri", "file_path", "path", "target", "action", "status"];

function prose(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function shorten(value: string, limit: number): string {
  const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  return parts.length <= limit ? value : parts.slice(0, Math.max(0, limit - 1)).map(p => p.segment).join("") + "…";
}

/** Presentation metadata is never interpreted as a command or inferred from its output. */
export function toolSummary(name: string, value: unknown, limit = 96): string {
  const args = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const description = prose(args.description) || prose(args.title);
  if (description) return shorten(description, limit);
  const category = processCategory(name);
  // Old transcripts and providers that omit descriptions still have an honest label.
  // Raw commands/code remain available only in the disclosed argument block.
  if (category.icon === "terminal") return t("执行 Shell 命令");
  if (category.icon === "command") return t("执行代码");
  const path = prose(args.path) || prose(args.file_path) || prose(args.file) || prose(args.url);
  let detail = path;
  if (name === "grep") detail = [path || ".", prose(args.query)].filter(Boolean).join(" · ");
  else if (name === "find") detail = [path || ".", prose(args.pattern)].filter(Boolean).join(" · ");
  else if (name === "lsp_query") detail = [path || ".", prose(args.action), prose(args.symbol)].filter(Boolean).join(" · ");
  else if (name === "delegate_task" || name === "fork_agent") detail = prose(args.label) || processDetail(args);
  return shorten(detail || processDetail(args) || t("查看工具详情"), limit);
}
export function processDetail(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const args = value as Record<string, unknown>;
  for (const field of detailFields) {
    const v = args[field];
    const text = typeof v === "string" ? v : Array.isArray(v)
      ? field === "questions" ? v.find(q => typeof q?.question === "string" && q.question.trim())?.question || ""
        : v.every(s => typeof s === "string") ? v.join(", ") : "" : "";
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized) return shorten(normalized, 160);
  }
  return "";
}

export function processSummary(calls: DurableEvent[], context = false): { label: string; icon: IconName } {
  const counts = new Map<string, { label: string; icon: IconName; count: number }>();
  const seen = new Set<string>();
  for (const call of calls) {
    const key = String(call.data["call-id"] || call.data.call_id || call.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const category = processCategory(String(call.data.name || ""));
    const previous = counts.get(category.label);
    counts.set(category.label, { ...category, count: (previous?.count || 0) + 1 });
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  return { label: ranked.length ? ranked.slice(0, 3).map(c => t(c.label)).join(" · ") : t(context ? "注入上下文" : "已完成分析"),
    icon: ranked[0]?.icon || (context ? "system" : "think") };
}
