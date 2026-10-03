import { createHash } from 'node:crypto';

export function hashText(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }

export class EditConflictError extends Error {
  constructor(code) { super(code); this.name = 'EditConflictError'; this.code = code; }
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function applyEdits(files, edits) {
  if (!object(files) || !Array.isArray(edits) || Object.values(files).some((value) => typeof value !== 'string')) {
    throw new TypeError('invalid file mapping or edit list');
  }
  const groups = new Map();
  for (const edit of edits) {
    if (!object(edit) || typeof edit.path !== 'string' || edit.path.length === 0 ||
        typeof edit.expectedHash !== 'string' || typeof edit.oldText !== 'string' || edit.oldText.length === 0 ||
        typeof edit.newText !== 'string') throw new TypeError('invalid edit');
    if (!Object.hasOwn(files, edit.path)) throw new EditConflictError('UNKNOWN_FILE');
    const original = files[edit.path];
    if (hashText(original) !== edit.expectedHash) throw new EditConflictError('STALE_HASH');
    const start = original.indexOf(edit.oldText);
    if (start < 0 || original.indexOf(edit.oldText, start + 1) >= 0) {
      throw new EditConflictError('TEXT_NOT_UNIQUE');
    }
    const group = groups.get(edit.path) ?? [];
    group.push({ start, end: start + edit.oldText.length, newText: edit.newText });
    groups.set(edit.path, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start);
    for (let index = 1; index < group.length; index += 1) {
      if (group[index].start < group[index - 1].end) throw new EditConflictError('OVERLAP');
    }
  }
  const result = { ...files };
  for (const [path, group] of groups) {
    let content = files[path];
    for (let index = group.length - 1; index >= 0; index -= 1) {
      const { start, end, newText } = group[index];
      content = content.slice(0, start) + newText + content.slice(end);
    }
    result[path] = content;
  }
  return result;
}
