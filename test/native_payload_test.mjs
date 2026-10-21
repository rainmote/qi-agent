// Pure linker-output fixtures; never loads native code or runs OS tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCommands, qualifyNative } from '../scripts/desktop/native-payload.mjs';

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
