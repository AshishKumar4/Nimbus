#!/usr/bin/env bun
// monaco-polish/new/resize-survives-frame-focus — a workspace handle held by
// the pointer keeps following it when the page's window loses focus to the
// preview's frame mid-drag: the pointer is still down. A frame the shell
// loads takes focus on its own (react-headless-guide, shell-phone-layout:
// the page's window lost focus to its frame), and a first drag under way
// then was dropped (resize-survives-lost-capture, "250 -> 250 -> 250").
import { BASE, mintSession, deleteSession, makeAsserter, readUntil } from '../../_driver.mjs';
import { grabHandle, launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

const a = makeAsserter('monaco-polish/new/resize-survives-frame-focus');
const sid = await mintSession();
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#treeResizeHandle', { visible: true, timeout: 30_000 });
  // The app preview's frame, shown.
  await page.waitForSelector('#previewTabs .preview-tab.markdown', { timeout: 30_000 });
  await page.locator('#previewTabs .preview-tab:not(.markdown)').click();
  await page.waitForSelector('#preview-frame', { visible: true, timeout: 15_000 });
  const width = () => page.$eval('#treePanel', (tree) => tree.getBoundingClientRect().width);
  const start = await width();

  const handle = await grabHandle(page, '#treeResizeHandle');
  await handle.move(40, 0);
  const held = await readUntil(width, (now) => now > start + 20);
  // The frame takes focus while the pointer is down: the window blurs.
  const blurred = await page.evaluate(() => new Promise((resolve) => {
    addEventListener('blur', () => resolve(true), { once: true });
    document.getElementById('preview-frame').focus();
    setTimeout(() => resolve(false), 2000);
  }));
  a.check('the frame took focus from the window', blurred && await page.evaluate(() => document.activeElement?.id) === 'preview-frame');
  await handle.move(140, 0);
  const after = await readUntil(width, (now) => now > held + 60);
  a.check('the drag follows the pointer after the window lost focus to the frame', after > held + 60, `${start} -> ${held} -> ${after}`);
  await handle.release();
  await page.mouse.move(handle.x + 240, handle.y, { steps: 5 });
  const released = await width();
  a.check('and ends when the pointer is released', Math.abs(released - after) <= 1, `${after} -> ${released}`);
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
