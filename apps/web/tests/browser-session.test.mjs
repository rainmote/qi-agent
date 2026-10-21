import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserAddress, observeBrowser, settleBrowser } from '../src/browser-session.ts';
const tab = { id: 'tab', lease: 'lease', acquisition: 'request', url: 'https://current.example/', title: 'current', revision: 4 };

test('an unconfirmed lease never becomes visible after a late successful observation or reply', () => {
  const unknown = [{ ...tab, unknown: true, loading: false, error: 'deadline' }];
  const observed = observeBrowser(unknown, { lease: 'lease', state: { revision: 4, unknown: false, confirmed: true, loading: true } }, '32123');
  assert.equal(observed[0].unknown, true); assert.equal(observed[0].loading, false);
  assert.equal(observed[0].error, 'deadline');
  assert.deepEqual(settleBrowser(observed, 'tab', 1, 1, { lease: 'lease', revision: 5, unknown: false }, 'request'), observed);
});

test('cleanup incarnation rejects delayed success even when the same tab UI remains', () => {
  const cleaned = [{ id: 'tab', url: tab.url, title: tab.title }];
  assert.equal(settleBrowser(cleaned, 'tab', 1, 2, { lease: 'closed-lease', revision: 8 }, 'old-request'), cleaned);
  const fresh = settleBrowser(cleaned, 'tab', 2, 2, { lease: 'new-lease', revision: 0 }, 'new-request');
  assert.equal(fresh[0].lease, 'new-lease'); assert.equal(fresh[0].acquisition, 'new-request');
  assert.deepEqual(observeBrowser(fresh, { lease: 'closed-lease', state: { unknown: false, revision: 9 } }, '32123'), fresh);
});

test('older navigation completion and acquisition replies cannot replace current navigation state', () => {
  const current = [{ ...tab, loading: true }];
  assert.deepEqual(observeBrowser(current, { lease: 'lease', state: { revision: 3, loading: false, url: 'https://old.example/' } }, '32123'), current);
  const result = settleBrowser(current, 'tab', 1, 1, { revision: 0, loading: false, url: 'https://old.example/' }, 'request');
  assert.equal(result[0].url, tab.url); assert.equal(result[0].loading, true); assert.equal(result[0].revision, 4);
  const finished = observeBrowser(current, { lease: 'lease', state: { revision: 4, loading: false, canBack: true, confirmed: true } }, '32123');
  assert.equal(finished[0].loading, false); assert.equal(finished[0].canBack, true); assert.equal(finished[0].confirmed, true);
});

test('native schemes, credentials and private Host port cannot be restored or accepted from page observations', () => {
  for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'https://user:pass@example.com', 'http://alias.example:32123']) assert.throws(() => browserAddress(url, '32123'));
  assert.equal(browserAddress('localhost:8000', '32123'), 'https://localhost:8000/');
  const observed = observeBrowser([tab], { lease: 'lease', state: { revision: 4, url: 'file:///etc/passwd' } }, '32123');
  assert.equal(observed[0].url, tab.url); assert.equal(observed[0].error, '页面导航地址被阻止');
});
