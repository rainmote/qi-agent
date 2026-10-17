import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent, normalizeMarkdown } from "./MarkdownContent";

test("renders assistant Markdown and GFM content", () => {
  const output = renderToStaticMarkup(<MarkdownContent content={[
    "# Result",
    "",
    "- **done**",
    "- [x] tested",
    "",
    "| name | value |",
    "| --- | --- |",
    "| answer | `42` |",
    "",
    "```clojure",
    "(+ 40 2)",
    "```",
  ].join("\n")} />);

  assert.match(output, /<h1>Result<\/h1>/);
  assert.match(output, /<strong>done<\/strong>/);
  assert.match(output, /type="checkbox"/);
  assert.match(output, /<table>/);
  assert.match(output, /class="language-clojure"/);
});

test("does not execute raw HTML and protects links", () => {
  const output = renderToStaticMarkup(<MarkdownContent
    content={'<script>alert("no")</script>\n\n[docs](https://example.com)'} />);

  assert.doesNotMatch(output, /<script>/);
  assert.match(output, /target="_blank"/);
  assert.match(output, /rel="noreferrer noopener"/);
});

test("repairs a legacy compact heading attached to a GFM table", () => {
  const output = renderToStaticMarkup(<MarkdownContent content={[
    "##为什么单字有实际问题|问题 |说明 |",
    "|---|---|",
    "|搜索 |难定位 |",
  ].join("\n")} />);

  assert.match(output, /<h2>为什么单字有实际问题<\/h2>/);
  assert.match(output, /<table>/);
  assert.match(output, /<th>问题<\/th>/);
  assert.match(output, /<td>难定位<\/td>/);
});

test("does not normalize compact Markdown inside code fences", () => {
  const source = "```text\n##literal|a|b|\n|---|---|\n```";
  assert.equal(normalizeMarkdown(source), source);
});
