#!/usr/bin/env bun
// monaco-polish/new/horizontal-resize-tree-editor — the tree↔editor
// handle, dragged in a real Chrome: it offers a column-resize cursor, the
// tree widens with the drag while it is held, and the width stays within
// 160-600 px however far it is dragged. Persistence is
// resize-persists-localStorage's.

import { BASE, mintSession, deleteSession, makeAsserter } from '../../_driver.mjs';
import { grabHandle, launchBrowser, openPage, readUntil } from '../../_runtime-behavioral-template.mjs';

const a = makeAsserter('monaco-polish/new/horizontal-resize-tree-editor');
const sid = await mintSession();
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#treeResizeHandle', { visible: true, timeout: 30_000 });
  a.check('the handle offers a column-resize cursor',
    await page.$eval('#treeResizeHandle', (handle) => getComputedStyle(handle).cursor) === 'col-resize');
  const width = () => page.$eval('#treePanel', (tree) => tree.getBoundingClientRect().width);
  const start = await width();

  const handle = await grabHandle(page, '#treeResizeHandle');
  await handle.move(80, 0);
  const held = await readUntil(width, (now) => now > start + 60);
  a.check('the tree widens with the drag while it is held', held > start + 60, `${start} -> ${held}`);
  // To the viewport's edges (1280 px wide), the drag's farthest reach each way.
  await handle.move(1279 - handle.x, 0);
  const widest = await readUntil(width, (now) => Math.abs(now - 600) <= 2);
  await handle.move(1 - handle.x, 0);
  const narrowest = await readUntil(width, (now) => Math.abs(now - 160) <= 2);
  await handle.release();
  a.check('dragged far right, the tree stops at 600 px', Math.abs(widest - 600) <= 2, String(widest));
  a.check('dragged far left, the tree stops at 160 px', Math.abs(narrowest - 160) <= 2, String(narrowest));
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
