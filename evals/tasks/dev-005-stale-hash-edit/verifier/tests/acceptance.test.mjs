import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hashText, EditConflictError, applyEdits } from '../src/hash-edit.mjs';

const edit = (files, path, oldText, newText) => ({ path, expectedHash: hashText(files[path]), oldText, newText });
const conflict = (code) => (error) => error instanceof Error && error instanceof EditConflictError &&
  error.name === 'EditConflictError' && error.code === code;

test('SHA-256 uses UTF-8 and lowercase hex', () => {
  assert.equal(hashText(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const text = '北京 🌧️\r\n';
  assert.equal(hashText(text), createHash('sha256').update(text, 'utf8').digest('hex'));
});

test('single edit preserves inputs and untouched files', () => {
  const files = { 'a.txt': 'before TARGET after', 'untouched.txt': 'keep me' };
  const edits = [edit(files, 'a.txt', 'TARGET', 'replacement')];
  const beforeFiles = structuredClone(files), beforeEdits = structuredClone(edits);
  const result = applyEdits(files, edits);
  assert.deepEqual(result, { 'a.txt': 'before replacement after', 'untouched.txt': 'keep me' });
  assert.notStrictEqual(result, files);
  assert.deepEqual(files, beforeFiles);
  assert.deepEqual(edits, beforeEdits);
});

test('same-file edits use the original snapshot despite replacement length and new target text', () => {
  const files = { 'a.txt': 'LEFT + MIDDLE + RIGHT' };
  const edits = [edit(files, 'a.txt', 'LEFT', 'RIGHT-right'), edit(files, 'a.txt', 'RIGHT', 'x'),
    edit(files, 'a.txt', 'MIDDLE', '')];
  const expected = { 'a.txt': 'RIGHT-right +  + x' };
  assert.deepEqual(applyEdits(files, edits), expected);
  assert.deepEqual(applyEdits(files, [...edits].reverse()), expected);
});

test('cross-file stale conflict leaves every original file unchanged', () => {
  const files = { 'a.txt': 'first', 'b.txt': 'second' };
  const before = structuredClone(files);
  const edits = [edit(files, 'a.txt', 'first', 'changed'),
    { ...edit(files, 'b.txt', 'second', 'changed'), expectedHash: hashText('older snapshot') }];
  assert.throws(() => applyEdits(files, edits), conflict('STALE_HASH'));
  assert.deepEqual(files, before);
});

test('missing files and inherited properties are not editable', () => {
  assert.throws(() => applyEdits({}, [{ path: 'missing', expectedHash: '', oldText: 'x', newText: 'y' }]), conflict('UNKNOWN_FILE'));
  const files = Object.create({ inherited: 'old' });
  files.own = 'unchanged';
  assert.throws(() => applyEdits(files, [edit(files, 'inherited', 'old', 'new')]), conflict('UNKNOWN_FILE'));
  assert.equal(files.own, 'unchanged');
});

test('missing, duplicate, and overlapping occurrences are rejected', () => {
  for (const [content, target] of [['abc', 'missing'], ['x x', 'x'], ['aaa', 'aa']]) {
    const files = { file: content };
    assert.throws(() => applyEdits(files, [edit(files, 'file', target, 'new')]), conflict('TEXT_NOT_UNIQUE'));
    assert.equal(files.file, content);
  }
  const files = { file: 'abcdef' };
  assert.throws(() => applyEdits(files, [edit(files, 'file', 'abc', 'x'), edit(files, 'file', 'cde', 'y')]), conflict('OVERLAP'));
  assert.throws(() => applyEdits(files, [edit(files, 'file', 'abc', 'x'), edit(files, 'file', 'abc', 'y')]), conflict('OVERLAP'));
  assert.equal(files.file, 'abcdef');
});

test('adjacent Unicode regions and literal replacement special characters work', () => {
  const files = Object.freeze({ text: '你好吗🌦️', other: 'safe' });
  const edits = Object.freeze([
    Object.freeze(edit(files, 'text', '你好', '$&')),
    Object.freeze(edit(files, 'text', '吗🌦️', '$1')),
  ]);
  assert.deepEqual(applyEdits(files, edits), { text: '$&$1', other: 'safe' });
});

test('empty batch returns a new mapping including special own keys', () => {
  const files = JSON.parse('{"__proto__":"one","constructor":"two"}');
  const result = applyEdits(files, []);
  assert.notStrictEqual(result, files);
  assert.deepEqual(result, files);
  const changed = applyEdits(files, [edit(files, '__proto__', 'one', 'new')]);
  assert.equal(Object.hasOwn(changed, '__proto__'), true);
  assert.equal(changed.__proto__, 'new');
  assert.equal(files.__proto__, 'one');
});

test('malformed input is rejected without mutation', () => {
  for (const files of [null, [], 'files', { a: 1 }]) assert.throws(() => applyEdits(files, []), TypeError);
  for (const edits of [null, {}, 'edits']) assert.throws(() => applyEdits({}, edits), TypeError);
  const files = { a: 'old' };
  const valid = edit(files, 'a', 'old', 'new');
  const invalid = [null, [], {}, { ...valid, path: '' }, { ...valid, expectedHash: null },
    { ...valid, oldText: '' }, { ...valid, oldText: 1 }, { ...valid, newText: null }];
  for (const item of invalid) {
    assert.throws(() => applyEdits(files, [valid, item]), TypeError);
    assert.deepEqual(files, { a: 'old' });
  }
});
