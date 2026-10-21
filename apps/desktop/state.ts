import { lstat, readFile } from "node:fs/promises";
import { writePrivateFileAtomically } from "../web-host/storage.js";

export function parseSavedPort(value: unknown): number {
  if (!value || typeof value !== "object" || !("port" in value)) throw new Error("Invalid desktop port state");
  const port = value.port;
  if (!Number.isInteger(port) || typeof port !== "number" || port < 1024 || port > 65535) {
    throw new Error("Invalid desktop port state");
  }
  return port;
}

export async function savedPort(path: string): Promise<number> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 || (info.mode & 0o077)) {
      throw new Error("Desktop port state must be a private regular file");
    }
    return parseSavedPort(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export async function rememberPort(path: string, port: number): Promise<void> {
  parseSavedPort({ port });
  await writePrivateFileAtomically(path, `${JSON.stringify({ port })}\n`);
}
