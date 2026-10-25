import { uiText as t } from "./i18n";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type PluginSlot = {
  id: string;
  "package-id": string;
  version: string;
  slot: "panel" | "tool-result";
  type: "text" | "markdown" | "metric" | "table";
  title: string;
  tool?: string;
  data: unknown;
};

const scalar = (value: unknown): value is string | number | boolean | null =>
  value === null || ["string", "number", "boolean"].includes(typeof value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, limit = 16000): value is string => typeof value === "string" && value.length <= limit;

/** Recheck data at the browser boundary; even a compromised transport cannot add executable renderers. */
export function validPluginData(type: PluginSlot["type"], value: unknown): boolean {
  if (!object(value)) return false;
  switch (type) {
    case "text": case "markdown": return text(value.text);
    case "metric": return (typeof value.value === "number" || text(value.value))
      && text(value.label, 120) && (value.unit === undefined || text(value.unit, 32));
    case "table": return Array.isArray(value.columns) && value.columns.length > 0 && value.columns.length <= 12
      && value.columns.every((column) => text(column, 120)) && Array.isArray(value.rows) && value.rows.length <= 200
      && value.rows.every((row) => Array.isArray(row) && row.length <= 12
        && row.every((cell) => scalar(cell) && (typeof cell !== "string" || cell.length <= 16000)));
    default: return false;
  }
}

function SlotContent({ slot, data }: { slot: PluginSlot; data: unknown }): ReactNode {
  if (!validPluginData(slot.type, data) || !object(data)) return <p role="status">{t("扩展数据格式不匹配，已停止显示。")}</p>;
  switch (slot.type) {
    case "text": return <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{data.text as string}</p>;
    case "markdown": return <div className="markdown-content"><Markdown remarkPlugins={[remarkGfm]} skipHtml
      components={{
        // Package content cannot silently contact external servers by loading images.
        img: ({ alt }) => <span>{alt || t("图片")}</span>,
        a: ({ href, children }) => href && /^https?:\/\//i.test(href)
          ? <a href={href} rel="noreferrer noopener" target="_blank">{children}</a> : <span>{children}</span>,
      }}>{data.text as string}</Markdown></div>;
    case "metric": return <div><span>{data.label as string}</span><p style={{ fontSize: "1.7rem", margin: "8px 0" }}>
      {String(data.value)} {data.unit as string | undefined}</p></div>;
    case "table": return <div style={{ overflowX: "auto", maxWidth: "100%" }}><table>
      <thead><tr>{(data.columns as string[]).map((column, index) => <th key={index}>{column}</th>)}</tr></thead>
      <tbody>{(data.rows as unknown[][]).map((row, index) => <tr key={index}>
        {row.map((cell, cellIndex) => <td key={cellIndex}>{cell === null ? "" : String(cell)}</td>)}
      </tr>)}</tbody></table></div>;
  }
}

export function PluginSlots({ slots, slot = "panel", toolName, data }: {
  slots: PluginSlot[];
  slot?: PluginSlot["slot"];
  toolName?: string;
  data?: unknown;
}) {
  const visible = slots.filter((entry) => entry.slot === slot
    && (slot !== "tool-result" || entry.tool === toolName)).slice(0, 64);
  if (!visible.length) return null;
  return <div className="plugin-slots" style={{ display: "grid", gap: 12, minWidth: 0 }}>
    {visible.map((entry) => <section key={`${entry["package-id"]}:${entry.id}`} aria-label={entry.title}
      style={{ border: "1px solid var(--border-2)", borderRadius: 10, padding: 14, minWidth: 0, overflowWrap: "anywhere" }}>
      <strong>{entry.title}</strong>
      <SlotContent slot={entry} data={data === undefined ? entry.data : data} />
      <small className="plugin-slot-source">{entry["package-id"]} · {entry.version}</small>
    </section>)}
  </div>;
}
