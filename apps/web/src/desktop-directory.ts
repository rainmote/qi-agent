/** Native selection only prefills the existing confirmation flow; it grants no access. */
export function desktopDirectory(value: unknown): string | null {
  return typeof value === "string" && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value)
    && (/^\//.test(value) || /^[a-z]:[\\/]/i.test(value)) ? value : null;
}
