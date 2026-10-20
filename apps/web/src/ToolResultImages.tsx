import { uiText as t } from "./i18n";
import { useId, useState } from "react";

// Tool output is untrusted. Only embedded raster images may load here: never
// fetch a URL returned by a tool, or allow active formats such as SVG.
const MAX_IMAGE_URL_LENGTH = 12 * 1024 * 1024;
const MAX_VISIBLE_IMAGES = 4;
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

function imageUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const image = value as Record<string, unknown>;
  const url = image.url;
  return image.type === "image" && typeof url === "string" &&
    url.length <= MAX_IMAGE_URL_LENGTH && RASTER_DATA_URL.test(url) ? url : null;
}

function ImagePreview({ url, index }: { url: string; index: number }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  return <figure className={`tool-image${expanded ? " is-expanded" : ""}`}>
    <figcaption>
      <span>{t("屏幕截图") + " "}{index}</span>
      {!failed && <button type="button" aria-expanded={expanded} aria-controls={id}
        onClick={() => setExpanded((current) => !current)}>
        {expanded ? t("收起截图 {0}", index) : t("放大截图 {0}", index)}
      </button>}
    </figcaption>
    <div id={id} className="tool-image-viewport" tabIndex={expanded ? 0 : undefined}
      role={expanded ? "region" : undefined} aria-label={expanded ? t("屏幕截图 {0} 原尺寸预览", index) : undefined}>
      {failed ? <p className="tool-image-note" role="status">{t("截图无法加载")}</p>
        : <img src={url} alt={t("工具返回的屏幕截图 {0}", index)} decoding="async"
          onError={() => setFailed(true)} />}
    </div>
  </figure>;
}

export function ToolResultImages({ images }: { images: unknown }) {
  if (!Array.isArray(images) || !images.length) return null;
  const previews: Array<{ url: string; index: number }> = [];
  for (let i = 0; i < images.length && previews.length < MAX_VISIBLE_IMAGES; i++) {
    const url = imageUrl(images[i]);
    if (url) previews.push({ url, index: i + 1 });
  }
  const omitted = images.length - previews.length;
  return <div className="tool-result-images" aria-label={t("工具截图")}>
    {previews.map(({ url, index }) => <ImagePreview key={`${index}:${url.length}`} url={url} index={index} />)}
    {omitted > 0 && <p className="tool-image-note">{omitted}{" " + t("张图片未预览：格式不支持或超出大小、数量限制。")}</p>}
  </div>;
}

/** Keep image payloads out of textual diagnostics and search indexes. */
export function imageDataReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("data:image/")) {
    const comma = value.indexOf(",");
    return comma > 0 && comma < 100 ? t("{0},[图片数据已省略]", value.slice(0, comma)) : t("[图片数据已省略]");
  }
  return value;
}
