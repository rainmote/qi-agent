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

// Read the selected arm64 slice, rather than trusting a path or caller-supplied
// executable flag. Shared libraries retain their unknown embedding context.
export function machOFileType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32) throw new Error('Truncated Mach-O header');
  const thin = (raw, subtype) => {
    const magic = raw.subarray(0,4).toString('hex');
    if (raw.length < 32 || !['cffaedfe','feedfacf'].includes(magic)) throw new Error('Unsupported arm64 Mach-O header');
    const word = at => magic === 'cffaedfe' ? raw.readUInt32LE(at) : raw.readUInt32BE(at);
    if (word(4) !== 0x0100000c || ![2,6,8].includes(word(12))) throw new Error('Unsupported arm64 Mach-O type');
    if (subtype !== undefined && word(8) !== subtype) throw new Error('Mismatched fat Mach-O CPU subtype');
    if (word(20) > raw.length - 32 || word(16) > Math.floor(word(20) / 8)) throw new Error('Mach-O commands escape the selected slice');
    return word(12);
  };
  const magic = bytes.subarray(0,4).toString('hex');
  if (['cffaedfe','feedfacf'].includes(magic)) return thin(bytes);
  const formats = {cafebabe:[false,false],bebafeca:[true,false],cafebabf:[false,true],bfbafeca:[true,true]};
  const format = formats[magic]; if (!format) throw new Error('Unsupported Mach-O header');
  const [little, wide] = format, word = at => little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  const count = word(4), step = wide ? 32 : 20, table = 8 + count * step;
  if (!count || count > 64 || table > bytes.length) throw new Error('Invalid fat Mach-O table');
  const ranges = [], selected = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * step;
    const number = index => {
      if (!wide) return word(index);
      const value = little ? bytes.readBigUInt64LE(index) : bytes.readBigUInt64BE(index);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Oversized fat Mach-O slice'); return Number(value);
    };
    const offset = number(at + 8), size = number(at + (wide ? 16 : 12));
    const align = word(at + (wide ? 24 : 16));
    if (align > 31 || offset % (2 ** align) || (wide && word(at + 28))) throw new Error('Invalid fat Mach-O alignment or reserved value');
    if (offset < table || size < 32 || offset + size > bytes.length || !Number.isSafeInteger(offset + size)
      || ranges.some(([start,end]) => offset < end && offset + size > start)) throw new Error('Invalid fat Mach-O range');
    ranges.push([offset,offset + size]);
    if (word(at) === 0x0100000c) selected.push([bytes.subarray(offset,offset + size),word(at + 4)]);
  }
  if (selected.length !== 1) throw new Error('Ambiguous or missing arm64 Mach-O slice');
  return thin(...selected[0]);
}

export function pillowRpathPlan({source, file, originalSha, commands}) {
  const buildPath = '/Users/runner/work/Pillow/Pillow/build/deps/darwin/lib';
  if (source?.kind !== 'wheel' || source.name !== 'pillow-12.3.0-cp312-cp312-macosx_11_0_arm64.whl'
    || source.sha256 !== 'ffd0c5368496f41b0944be820fcb7a838aa6e623d250b01acf2643939c3f99d7'
    || file !== 'python/lib/python3.12/site-packages/PIL/.dylibs/libjpeg.62.4.0.dylib'
    || originalSha !== 'cf7c4e5c2d2c007fc51afcb95b649415cfe0bc4d7137ace897a6eff6550fa967'
    || commands.rpaths.length !== 1 || commands.rpaths[0] !== buildPath
    || !commands.dependencies.length || commands.dependencies.some(path => !system(path))) {
    throw new Error('Unreviewed native normalization input');
  }
  return {deleteRpath:buildPath,originalSha,file,source:source.name};
}

export function qualifyPillowDerivation(before, after) {
  const architectures = value => value.trim().split(/\s+/).sort().join(' ');
  if (machOFileType(before.fileBytes) !== 6 || machOFileType(after.fileBytes) !== 6
    || architectures(before.architectures) !== architectures(after.architectures)
    || !before.commands.dylibId || after.commands.dylibId !== before.commands.dylibId
    || after.commands.rpaths.length || JSON.stringify(after.commands.dependencies) !== JSON.stringify(before.commands.dependencies)
    || JSON.stringify(after.commands.minOS) !== JSON.stringify(before.commands.minOS)) throw new Error('Unexpected native derivative identity or load commands');
}

export function loadCommands(text) {
  const result = { dependencies: [], rpaths: [], minOS: [] };
  for (const block of text.split(/Load command \d+\n/).slice(1)) {
    const command = block.match(/^\s*cmd (\S+)$/m)?.[1];
    if (['LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB', 'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB'].includes(command)) {
      const name = block.match(/^\s*name (.+) \(offset \d+\)$/m)?.[1];
      if (!name) throw new Error('Unparsed native dependency'); result.dependencies.push(name);
    } else if (command === 'LC_ID_DYLIB') {
      if (result.dylibId || !block.match(/^\s*name (.+) \(offset \d+\)$/m)) throw new Error('Invalid native dylib identity');
      result.dylibId = block.trim();
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

export function qualifyNative({ root, file, architectures, commands, minimumOS, regularFiles, fileBytes }) {
  if (!architectures.trim().split(/\s+/).includes('arm64')) throw new Error('Native payload has no arm64 slice');
  if (!commands.minOS.length || commands.minOS.some(value => newer(value, minimumOS))) throw new Error('Native payload requires an unsupported macOS version');
  const loader = dirname(file);
  const selfExecutable = fileBytes !== undefined && machOFileType(fileBytes) === 2;
  const expand = path => {
    if (path === '@loader_path' || path.startsWith('@loader_path/')) return resolve(loader, '.' + path.slice(12));
    if (path === '@executable_path' || path.startsWith('@executable_path/')) {
      if (!selfExecutable) throw new Error('Unresolved native loader path');
      return resolve(loader, '.' + path.slice(16));
    }
    // Shared libraries cannot guess a Node/Python/engine embedding executable.
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
