import { createHash } from 'node:crypto';

export function hashText(text) { return createHash('sha256').update(text, 'utf8').digest('hex'); }

export class EditConflictError extends Error {
  constructor(code) { super(code); this.name = 'EditConflictError'; this.code = code; }
}

export function applyEdits(files, edits) {
  for (const edit of edits) {
    if (!(edit.path in files)) throw new EditConflictError('UNKNOWN_FILE');
    if (hashText(files[edit.path]) !== edit.expectedHash) throw new EditConflictError('STALE_HASH');
    files[edit.path] = files[edit.path].replace(edit.oldText, edit.newText);
  }
  return files;
}
