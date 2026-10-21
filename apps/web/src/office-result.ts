export const officeCancellationEvent = "qi-office-cancel-intent";

export function officeResult(value: unknown): { output: string; bytes: number; previewable: boolean } {
  const result = value as { converted?: unknown; output?: unknown; bytes?: unknown } | null;
  if (result?.converted !== true || typeof result.output !== "string" || result.output.length > 2048
    || !/\.pdf$/i.test(result.output) || /[\\\x00-\x1f\x7f]/.test(result.output)
    || result.output.split("/").some(part => !part || part === "." || part === "..")
    || typeof result.bytes !== "number" || !Number.isSafeInteger(result.bytes) || result.bytes <= 0 || result.bytes > 40_000_000) {
    throw new Error("PDF conversion did not return a confirmed output; inspect the chosen path before retrying.");
  }
  return { output: result.output, bytes: result.bytes, previewable: result.bytes <= 8 * 1024 * 1024 };
}
