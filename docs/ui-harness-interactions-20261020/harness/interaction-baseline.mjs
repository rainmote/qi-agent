import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { browser, base, fixture } from '../qi-agent/apps/web/tests/browser-fixture.mjs';
const out='/Users/geb/Documents/Codex/2026-10-19/task-2/interaction-20261020/before';await fs.mkdir(out,{recursive:true});
try {
 const {page}=await fixture();await page.goto(base);await page.locator('.session-header-title button').waitFor();
 await page.locator('.sidebar-settings').click();await page.getByRole('menuitem',{name:'设置',exact:true}).click();await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
 await page.screenshot({path:`${out}/01-settings-1440.png`,animations:'disabled'});
 await page.getByRole('button',{name:'编辑快捷键',exact:true}).click();await page.getByRole('region',{name:'编辑快捷键',exact:true}).waitFor();await page.screenshot({path:`${out}/02-shortcuts-1440.png`,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${out}/03-shortcuts-390.png`,animations:'disabled'});
 assert.equal(await page.getByRole('searchbox',{name:'搜索快捷键',exact:true}).count(),1,'the current shortcut catalog must be searchable');
}finally{await browser.close();}
