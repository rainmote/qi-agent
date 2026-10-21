// Build-owned derivative only. Never launches a payload or loads native code.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadCommands, machOFileType, pillowRpathPlan, qualifyNative, qualifyPillowDerivation } from './native-payload.mjs';

const hash = raw => createHash('sha256').update(raw).digest('hex');
const entry = 'python/lib/python3.12/site-packages/PIL/.dylibs/libjpeg.62.4.0.dylib';

export async function normalizePillow(root, lock, run, minimumOS) {
  if (lock.target !== 'aarch64-apple-darwin' || await realpath(root) !== resolve(root)) throw new Error('Unsupported native derivative root');
  const sources = lock.sources.filter(source => source.name === 'pillow-12.3.0-cp312-cp312-macosx_11_0_arm64.whl');
  if (sources.length !== 1) throw new Error('Missing or ambiguous Pillow archive');
  const file = join(root,entry);
  for (const name of [root,...entry.split('/').map((_,i,parts) => join(root,...parts.slice(0,i+1)))]) {
    const info = await lstat(name);
    if (info.isSymbolicLink() || (name === file ? !info.isFile() : !info.isDirectory())) throw new Error('Linked or non-regular native derivative');
  }
  const before = await readFile(file), originalSha = hash(before);
  if (machOFileType(before) !== 6) throw new Error('Expected an arm64 shared library');
  const commands = loadCommands(run('/usr/bin/otool',['-arch','arm64','-l',file]));
  const architectures = run('/usr/bin/lipo',['-archs',file]);
  const plan = pillowRpathPlan({source:sources[0],file:entry,originalSha,commands});
  const tools = {};
  for (const tool of ['/usr/bin/install_name_tool','/usr/bin/codesign','/usr/bin/otool','/usr/bin/lipo']) tools[tool] = hash(await readFile(tool));
  // Only this exact unused upstream build path is removed. Do not rewrite
  // dependencies, add search paths, or relax the qualifier for external paths.
  run('/usr/bin/install_name_tool',['-delete_rpath',plan.deleteRpath,file]);
  run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',file]);
  run('/usr/bin/codesign',['--verify','--strict',file]);
  const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Native derivative replaced by non-regular file');
  const after = await readFile(file), nextCommands = loadCommands(run('/usr/bin/otool',['-arch','arm64','-l',file]));
  const nextArchitectures = run('/usr/bin/lipo',['-archs',file]);
  qualifyPillowDerivation({fileBytes:before,architectures,commands},{fileBytes:after,architectures:nextArchitectures,commands:nextCommands});
  qualifyNative({root,file,fileBytes:after,architectures:nextArchitectures,
    commands:nextCommands,minimumOS,regularFiles:new Set([file])});
  for (const [tool,pin] of Object.entries(tools)) if (hash(await readFile(tool)) !== pin) throw new Error('Native build tool changed');
  return {entry,source_archive:sources[0].name,source_archive_sha256:sources[0].sha256,
    original_sha256:originalSha,derived_sha256:hash(after),removed_rpath:plan.deleteRpath,
    native_tools_sha256:tools,signature:'ad-hoc verified; no key or timestamp service',qualification:'STATIC_ONLY; actual imports not verified'};
}
