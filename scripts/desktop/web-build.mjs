import { build } from 'vite';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat } from 'node:fs/promises';

// Packaging must not read a workstation's ignored .env or .env.* files.
// The parent also supplies a minimal environment without VITE_* overrides.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspace = process.argv[2] ? resolve(process.argv[2]) : null;
const aliases = [];
if (workspace) {
  const stage = join(repo, 'apps/desktop/stage');
  if (dirname(workspace) !== stage || !/^workspace-[a-f0-9-]{36}$/.test(workspace.slice(stage.length + 1))) throw new Error('Invalid owned workspace stage');
  for (const [name, entry] of [['@xterm/xterm', 'lib/xterm.js'], ['@xterm/addon-fit', 'lib/addon-fit.js']]) {
    const file = join(workspace, 'node_modules', name, entry);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Missing pinned terminal renderer');
    aliases.push({ find: name, replacement: file });
  }
  aliases.push({ find: '@qi-terminal-renderer-css', replacement: join(workspace, 'node_modules/@xterm/xterm/css/xterm.css') });
  aliases.push({ find: /^\.\/terminal-emulator$/, replacement: join(repo, 'scripts/desktop/terminal-entry.mjs') });
}
await build({ envDir: false, resolve: { alias: aliases }, build: { sourcemap: false } });
