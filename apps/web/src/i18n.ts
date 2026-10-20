import { getWebPreferences } from "./web-preferences";
import { english } from "./web-english";

export const uiLocale = () => getWebPreferences().locale === "en" ? "en-US" : "zh-CN";

/** Translate only application-owned copy; model messages, files and backend payloads stay verbatim. */
export function uiText(source: string, ...values: unknown[]): string {
  const template = getWebPreferences().locale === "en" ? english[source] ?? source : source;
  return template.replace(/\{(\d+)\}/g, (match, index: string) => Number(index) < values.length ? String(values[Number(index)]) : match);
}
