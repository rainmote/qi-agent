import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { WorkspaceLink } from "./WorkspaceLinks";

interface MarkdownContentProps {
  content: string;
}

const tableDelimiter = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const fenceStart = /^\s{0,3}(`{3,}|~{3,})/;
const cjkStart = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Stable component identity keeps the focused anchor mounted from pointer down to click.
const markdownComponents: Components = {
  a: ({ children, node: _node, ...props }) => <WorkspaceLink {...props}>{children}</WorkspaceLink>,
};

/**
 * Older OpenAI-compatible sessions may have lost standalone whitespace deltas.
 * Repair only unambiguous Markdown boundaries: CJK-style ATX headings and a
 * table header glued to a heading immediately before a GFM delimiter row.
 */
export function normalizeMarkdown(content: string): string {
  const lines = content.split("\n");
  const output: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    const fenceMatch = line.match(fenceStart);
    if (fenceMatch) {
      const token = fenceMatch[1];
      if (!fence) fence = { marker: token[0], length: token.length };
      else if (token[0] === fence.marker && token.length >= fence.length) fence = null;
      output.push(line);
      continue;
    }
    if (fence) {
      output.push(line);
      continue;
    }

    const heading = line.match(/^(\s{0,3}#{1,6})(?!#)(.*)$/);
    if (heading) {
      const firstPipe = heading[2].indexOf("|");
      if (firstPipe >= 0 && tableDelimiter.test(lines[index + 1] || "")) {
        const title = heading[2].slice(0, firstPipe).trimEnd();
        const tableHeader = heading[2].slice(firstPipe);
        output.push(`${heading[1]} ${title}`, "", tableHeader);
        continue;
      }
      if (cjkStart.test(heading[2])) line = `${heading[1]} ${heading[2]}`;
    }
    output.push(line);
  }
  return output.join("\n");
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  return <div className="markdown-content">
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={markdownComponents}>
      {normalizeMarkdown(content)}
    </Markdown>
  </div>;
}
