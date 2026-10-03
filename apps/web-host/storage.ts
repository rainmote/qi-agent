import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

async function existingPath(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  if (dirname(absolute) === absolute) {
    throw new Error("Refusing to use the filesystem root as private state");
  }
  const before = await existingPath(absolute);
  if (before && (!before.isDirectory() || before.isSymbolicLink())) {
    throw new Error(`Private state path must be a real directory: ${absolute}`);
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const after = await lstat(absolute);
  if (!after.isDirectory() || after.isSymbolicLink()) {
    throw new Error(`Private state path must be a real directory: ${absolute}`);
  }
  await chmod(absolute, 0o700);
}

export async function writePrivateFileAtomically(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  const temporary = join(parent,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
