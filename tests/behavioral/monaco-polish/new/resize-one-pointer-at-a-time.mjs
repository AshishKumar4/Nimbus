#!/usr/bin/env bun
// monaco-polish/new/resize-one-pointer-at-a-time — a workspace handle held by
// one pointer keeps its drag when a second pointer (a touch) presses and
// lifts on another handle: the tree does not move, and the held drag goes
// on following its own pointer until that pointer is released.

import { BASE, mintSession, deleteSession, makeAsserter, readUntil } from '../../_driver.mjs';
import { grabHandle, launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

const a = makeAsserter('monaco-polish/new/resize-one-pointer-at-a-time');
const sid = await mintSession();
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#resizeHandle', { visible: true, timeout: 30_000 });
  const widths = () => page.evaluate(() => ({
    tree: document.getElementById('treePanel').getBoundingClientRect().width,
    center: document.getElementById('leftStack').getBoundingClientRect().width,
  }));
  const tree = await (await page.$('#treeResizeHandle')).boundingBox();
  const start = await widths();

  const handle = await grabHandle(page, '#resizeHandle');
  await handle.move(-60, 0);
  const held = await readUntil(widths, (now) => now.center < start.center - 40);
  // A second pointer presses on the tree's handle, moves and lifts.
  const touch = await page.target().createCDPSession();
  const at = (dx) => [{ x: tree.x + tree.width / 2 + dx, y: tree.y + tree.height / 2, id: 1 }];
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(120) });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await handle.move(-160, 0);
  const after = await readUntil(widths, (now) => now.center < held.center - 60);
  await handle.release();
  a.check('the second pointer does not move the tree', Math.abs(after.tree - start.tree) <= 1, JSON.stringify({ start, after }));
  a.check('the held drag goes on following its own pointer', after.center < held.center - 60, JSON.stringify({ held, after }));
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
