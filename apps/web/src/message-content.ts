/** Use the same visible content in history, folding and message actions. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2) || "";
  return content.filter(item => item && typeof item === "object" && item.type === "text" && typeof item.text === "string")
    .map(item => item.text as string).filter(value => value.length > 0).join("\n");
}

export function hasMessageContent(content: unknown): boolean {
  return Boolean(messageText(content)) || (Array.isArray(content)
    && content.some(item => item && typeof item === "object" && item.type === "attachment"));
}
