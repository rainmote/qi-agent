// Static macOS payload qualification. The caller supplies read-only tools;
// this module never launches a packaged executable or loads a native addon.
import { isAbsolute, dirname, resolve, relative } from 'node:path';

export const machOMagics = new Set(['cefaedfe', 'cffaedfe', 'feedface', 'feedfacf', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const system = path => {
  if (!isAbsolute(path)) return false;
  const canonical = resolve(path);
  return canonical.startsWith('/usr/lib/') || canonical.startsWith('/System/Library/');
};
const inside = (root, path) => { const name = relative(root, path); return name !== '..' && !name.startsWith('../') && !isAbsolute(name); };
const version = text => { if (!/^\d+(?:\.\d+){0,2}$/.test(text)) throw new Error('Invalid native deployment version'); return text.split('.').map(Number); };
const newer = (left, right) => { const a = version(left), b = version(right); for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return false; };

export function loadCommands(text) {
  const result = { dependencies: [], rpaths: [], minOS: [] };
  for (const block of text.split(/Load command \d+\n/).slice(1)) {
    const command = block.match(/^\s*cmd (\S+)$/m)?.[1];
    if (['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB'].includes(command)) {
      const name = block.match(/^\s*name (.+) \(offset \d+\)$/m)?.[1];
      if (!name) throw new Error('Unparsed native dependency'); result.dependencies.push(name);
    } else if (command === 'LC_RPATH') {
      const path = block.match(/^\s*path (.+) \(offset \d+\)$/m)?.[1];
      if (!path) throw new Error('Unparsed native rpath'); result.rpaths.push(path);
    } else if (command === 'LC_BUILD_VERSION') {
      // macOS is platform 1; iOS/Catalyst cannot qualify this macOS payload.
      const platform = block.match(/^\s*platform (\S+)$/m)?.[1];
      const minOS = block.match(/^\s*minos (\S+)$/m)?.[1];
      if (!['1', 'MACOS', 'macos'].includes(platform) || !minOS) throw new Error('Unsupported native platform');
      result.minOS.push(minOS);
    } else if (command === 'LC_VERSION_MIN_MACOSX') {
      const minOS = block.match(/^\s*version (\S+)$/m)?.[1];
      if (!minOS) throw new Error('Missing native minimum OS'); result.minOS.push(minOS);
    }
  }
  return result;
}

export function qualifyNative({ root, file, architectures, commands, minimumOS, regularFiles }) {
  if (!architectures.trim().split(/\s+/).includes('arm64')) throw new Error('Native payload has no arm64 slice');
  if (!commands.minOS.length || commands.minOS.some(value => newer(value, minimumOS))) throw new Error('Native payload requires an unsupported macOS version');
  const loader = dirname(file);
  const expand = path => {
    if (path === '@loader_path' || path.startsWith('@loader_path/')) return resolve(loader, '.' + path.slice(12));
    // @executable_path depends on the particular embedding executable. This
    // verifier does not guess a Node/Python/engine host for a shared library.
    if (path.startsWith('@')) throw new Error('Unresolved native loader path');
    if (!isAbsolute(path)) throw new Error('Relative native dependency'); return path;
  };
  const rpaths = commands.rpaths.map(expand);
  for (const path of rpaths) if (!system(path + '/') && !inside(root, path)) throw new Error('Native rpath escapes bundle');
  for (const dependency of commands.dependencies) {
    if (system(dependency)) continue;
    const candidates = dependency.startsWith('@rpath/')
      ? rpaths.map(path => resolve(path, dependency.slice(7))) : [expand(dependency)];
    if (!candidates.some(path => inside(root, path) && regularFiles.has(path))) throw new Error('Native dependency is absent or escapes bundle');
  }
}
