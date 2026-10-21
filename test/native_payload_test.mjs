// Pure linker-output fixtures; never loads native code or runs OS tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as payload from '../scripts/desktop/native-payload.mjs';
const { loadCommands, qualifyNative } = payload;

const base = { root: '/fixture/runtime', file: '/fixture/runtime/python/bin/python3.12', architectures: 'arm64', minimumOS: '14.0',
  regularFiles: new Set(['/fixture/runtime/python/lib/libpython.dylib']) };
const commands = { minOS: ['13.0'], rpaths: ['@loader_path/../lib'], dependencies: ['@rpath/libpython.dylib', '/usr/lib/libSystem.B.dylib'] };

test('owned relative dylibs and system dependencies qualify only with arm64 and supported minimum OS', () => {
  assert.doesNotThrow(() => qualifyNative({ ...base, commands }));
  for (const changed of [{ architectures: 'x86_64' }, { commands: { ...commands, minOS: ['15.0'] } },
    { commands: { ...commands, minOS: [] } }, { regularFiles: new Set() }]) {
    assert.throws(() => qualifyNative({ ...base, commands, ...changed }));
  }
});

test('external, escaped, missing or embedding-dependent native links remain rejected', () => {
  for (const dependency of ['/opt/homebrew/lib/libpython.dylib', '@loader_path/../../../private/lib.dylib',
    '/usr/lib/../../opt/homebrew/lib/libpython.dylib', '/System/Library/../../Users/fixture/lib.dylib',
    '@rpath/missing.dylib', '@executable_path/../lib/libpython.dylib', 'libpython.dylib']) {
    assert.throws(() => qualifyNative({ ...base, commands: { ...commands, dependencies: [dependency] } }));
  }
  assert.throws(() => qualifyNative({ ...base, commands: { ...commands, rpaths: ['/opt/homebrew/lib'] } }));
  assert.throws(() => qualifyNative({ ...base, commands: { ...commands, rpaths: ['/usr/lib/../../opt/homebrew/lib'] } }));
});

test('parse actual otool load-command forms and reject unsupported Apple platforms', () => {
  const text = 'header\nLoad command 0\n cmd LC_BUILD_VERSION\n platform 1\n minos 13.0\nLoad command 1\n cmd LC_RPATH\n path @loader_path/../lib (offset 12)\nLoad command 2\n cmd LC_LOAD_DYLIB\n name @rpath/libpython.dylib (offset 24)\n';
  assert.deepEqual(loadCommands(text), { minOS: ['13.0'], rpaths: ['@loader_path/../lib'], dependencies: ['@rpath/libpython.dylib'] });
  assert.throws(() => loadCommands(text.replace('platform 1', 'platform 2')));
  assert.throws(() => loadCommands(text.replace('name @rpath/libpython.dylib (offset 24)', 'unparsed dependency')));
});

const header = (type = 2, cpu = 0x0100000c) => {
  const raw = Buffer.alloc(32); raw.writeUInt32LE(0xfeedfacf,0); raw.writeUInt32LE(cpu,4); raw.writeUInt32LE(type,12); return raw;
};
const fileType = raw => payload.machOFileType ? payload.machOFileType(raw) : 0;

test('self executable paths qualify only from the selected actual arm64 MH_EXECUTE header', () => {
  const file = header();
  assert.equal(fileType(file),2,'the actual arm64 executable header must be recognized');
  const fat = Buffer.alloc(112); fat.writeUInt32BE(0xcafebabe,0); fat.writeUInt32BE(2,4);
  fat.writeUInt32BE(0x01000007,8); fat.writeUInt32BE(48,16); fat.writeUInt32BE(32,20);
  fat.writeUInt32BE(0x0100000c,28); fat.writeUInt32BE(80,36); fat.writeUInt32BE(32,40);
  header(6,0x01000007).copy(fat,48); header(2).copy(fat,80);
  assert.equal(fileType(fat),2);
  assert.doesNotThrow(() => qualifyNative({...base,fileBytes:file,commands:{...commands,rpaths:['@executable_path/../lib']}}));
  assert.throws(() => qualifyNative({...base,fileType:2,fileBytes:header(6),commands:{...commands,rpaths:['@executable_path/../lib']}}));
  assert.throws(() => qualifyNative({...base,fileBytes:file,commands:{...commands,rpaths:['@executable_path/../../../outside']}}));
});

test('truncated, mismatched, ambiguous and out-of-bounds arm64 headers cannot grant executable context', () => {
  const invalid = [header().subarray(0,16),header(2,0x01000007),header(0),Buffer.alloc(32)];
  const fat=Buffer.alloc(48);fat.writeUInt32BE(0xcafebabe,0);fat.writeUInt32BE(2,4);
  for (const offset of [8,28]) {fat.writeUInt32BE(0x0100000c,offset);fat.writeUInt32BE(1024,offset+8);fat.writeUInt32BE(32,offset+12);}
  invalid.push(fat);
  for (const raw of invalid) assert.throws(() => fileType(raw));
});

const pillowSource = {kind:'wheel',name:'pillow-12.3.0-cp312-cp312-macosx_11_0_arm64.whl',sha256:'ffd0c5368496f41b0944be820fcb7a838aa6e623d250b01acf2643939c3f99d7'};
const pillow = {source:pillowSource,file:'python/lib/python3.12/site-packages/PIL/.dylibs/libjpeg.62.4.0.dylib',
  originalSha:'cf7c4e5c2d2c007fc51afcb95b649415cfe0bc4d7137ace897a6eff6550fa967',
  commands:{minOS:['11.0'],dependencies:['/usr/lib/libSystem.B.dylib'],rpaths:['/Users/runner/work/Pillow/Pillow/build/deps/darwin/lib']}};
const rpathPlan = input => payload.pillowRpathPlan ? payload.pillowRpathPlan(input) : null;

test('only the pinned Pillow copy with its one unused build rpath receives a normalization plan', () => {
  const plan=rpathPlan(pillow);
  assert.ok(plan,'the known unusable build path needs an explicit derived-file plan');
  assert.equal(plan.deleteRpath,pillow.commands.rpaths[0]);
  for (const changed of [{originalSha:'0'.repeat(64)},{source:{...pillowSource,sha256:'0'.repeat(64)}},
    {file:'../outside.dylib'},{commands:{...pillow.commands,dependencies:['@rpath/libSystem.B.dylib']}},
    {commands:{...pillow.commands,dependencies:['/opt/homebrew/lib/libx.dylib']}},
    {commands:{...pillow.commands,rpaths:[...pillow.commands.rpaths,'/unreviewed']}}]) {
    assert.throws(() => rpathPlan({...pillow,...changed}));
  }
});

const fatFixture = (wide = false) => {
  const raw=Buffer.alloc(96);raw.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe,0);raw.writeUInt32BE(1,4);
  raw.writeUInt32BE(0x0100000c,8);
  if (wide) {raw.writeBigUInt64BE(64n,16);raw.writeBigUInt64BE(32n,24);raw.writeUInt32BE(6,32);}
  else {raw.writeUInt32BE(64,16);raw.writeUInt32BE(32,20);raw.writeUInt32BE(6,24);}
  header().copy(raw,64);return raw;
};
for (const [name,mutate,wide] of [
  ['CPU subtype mismatch',raw => raw.writeUInt32LE(2,72),false],
  ['unaligned slice',raw => raw.writeUInt32BE(7,24),false],
  ['load commands outside slice',raw => raw.writeUInt32LE(128,84),false],
  ['fat64 reserved value',raw => raw.writeUInt32BE(1,36),true],
]) test('malformed fat header rejects '+name,() => {const raw=fatFixture(wide);mutate(raw);assert.throws(() => fileType(raw));});

test('dylib identity is parsed and cannot silently change during build normalization', () => {
  const identity=' cmd LC_ID_DYLIB\n cmdsize 64\n name @rpath/libjpeg.62.dylib (offset 24)\n current version 62.4.0\n compatibility version 62.0.0';
  assert.equal(loadCommands('header\nLoad command 0\n'+identity+'\n').dylibId,identity.trim());
  const before={fileBytes:header(6),architectures:'arm64',commands:{...pillow.commands,dylibId:identity}};
  const after={...before,commands:{...before.commands,rpaths:[]}};
  const check=(left,right) => payload.qualifyPillowDerivation?.(left,right);
  assert.doesNotThrow(() => check(before,after));
  for (const changed of [{fileBytes:header(2)},{architectures:'arm64 x86_64'},
    {commands:{...after.commands,dylibId:'changed'}},{commands:{...after.commands,minOS:['15.0']}},
    {commands:{...after.commands,rpaths:['/another/path']}},{commands:{...after.commands,dependencies:['/usr/lib/other.dylib']}}]) {
    assert.throws(() => check(before,{...after,...changed}));
  }
});
