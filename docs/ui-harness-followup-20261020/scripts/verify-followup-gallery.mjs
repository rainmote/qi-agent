import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '../qi-agent/node_modules/playwright/index.mjs';

const task = '/Users/geb/Documents/Codex/2026-10-19/task-2';
const folder = process.argv[2] || path.join(task, 'qi-agent/docs/ui-harness-followup-20261020');
const artifacts = path.join(task, 'pixel-followup-20261020/gallery');
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const errors = [];
const checked = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(pathToFileURL(path.join(folder, 'index.html')).href);
  const names = await page.locator('#state option').evaluateAll(options => options.map(option => option.value));
  assert.equal(names.length, 28);
  for (const name of names) {
    await page.locator('#state').selectOption(name);
    for (const mode of ['side-by-side', 'overlay', 'diff-x4', 'reference', 'candidate', 'baseline']) {
      const button = page.locator(`[data-mode="${mode}"]`);
      if (await button.isDisabled()) {
        assert.equal(mode, 'baseline');
        checked.push({ name, mode, available: false });
        continue;
      }
      await button.click();
      await page.locator('#visual').evaluate(image => image.decode());
      const image = await page.locator('#visual').evaluate(image => ({
        path: image.getAttribute('src'), width: image.naturalWidth, height: image.naturalHeight,
      }));
      assert.ok(image.width > 0 && image.height > 0);
      checked.push({ name, mode, available: true, ...image });
    }
  }
  await page.locator('#state').selectOption('new-session-light-1440');
  await page.locator('[data-mode="side-by-side"]').click();
  await page.locator('#visual').evaluate(image => image.decode());
  await page.screenshot({ path: path.join(artifacts, 'gallery-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#state').selectOption('new-session-light-390');
  await page.locator('[data-mode="overlay"]').click();
  await page.locator('#visual').evaluate(image => image.decode());
  await page.screenshot({ path: path.join(artifacts, 'gallery-mobile.png') });
  assert.deepEqual(errors, []);
  const result = { gallery: 'passed', states: names.length, checked,
    html_sha256: createHash('sha256').update(await readFile(path.join(folder, 'index.html'))).digest('hex'),
    browser: browser.version(), pageErrors: errors };
  await writeFile(path.join(artifacts, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ gallery: result.gallery, states: result.states,
    loaded: checked.filter(item => item.available).length,
    missingBaselineDisabled: checked.filter(item => !item.available).length,
    browser: result.browser, html_sha256: result.html_sha256, pageErrors: errors }));
} finally {
  await browser.close();
}
