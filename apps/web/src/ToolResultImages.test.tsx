import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolResultImages } from "./ToolResultImages";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDfcAAAAASUVORK5CYII=";

test("tool screenshots render as bounded accessible previews, never as text", () => {
  const html = renderToStaticMarkup(<ToolResultImages images={[{ type: "image", url: png, detail: "auto" }]} />);
  assert.match(html, /class="tool-image-viewport"/);
  assert.match(html, /alt="工具返回的屏幕截图 1"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="[^"]+"/);
  assert.match(html, /放大截图 1/);
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ""), /data:image|iVBOR/);
});

test("tool previews reject remote, active, malformed and oversized image sources", () => {
  const images = [
    { type: "image", url: "https://untrusted.invalid/tracking.png" },
    { type: "image", url: "file:///private/screenshot.png" },
    { type: "image", url: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" },
    { type: "image", url: "data:image/png;base64,not base64" },
    { type: "image", url: `data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}` },
    { type: "text", url: png },
    null,
  ];
  const html = renderToStaticMarkup(<ToolResultImages images={images} />);
  assert.doesNotMatch(html, /<img |untrusted|private|PHN2Zz|data:image/);
  assert.match(html, /7 张图片未预览/);
  assert.equal(renderToStaticMarkup(<ToolResultImages images={null} />), "");
});

test("one tool result cannot mount an unbounded screenshot gallery", () => {
  const html = renderToStaticMarkup(<ToolResultImages images={Array.from({ length: 20 }, () => ({ type: "image", url: png }))} />);
  assert.equal((html.match(/<img /g) || []).length, 4);
  assert.match(html, /16 张图片未预览/);
});
