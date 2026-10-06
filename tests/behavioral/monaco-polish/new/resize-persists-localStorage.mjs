#!/usr/bin/env bun
// monaco-polish/new/resize-persists-localStorage — the pane sizes the user
// drags are kept: dragging the editor↔terminal handle and the file tree's
// edge stores the split and the tree width under this session's key
// (nimbus.pane.dims./s/<sid>), and a reload of the page lays the panes out
// at that split and that width again. Driven in a real Chrome.

import { BASE, deleteSession, makeAsserter, mintSession } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/resize-persists-localStorage');
console.log(`monaco-polish/new/resize-persists-localStorage — ${process.env.BASE}`);

const sid = await mintSession();
const KEY = `nimbus.pane.dims./s/${sid}`;

const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#editorTerminalResizeHandle', { visible: true, timeout: 30_000 });

  const editorHeight = () => page.evaluate(() => document.getElementById('editorPanel').getBoundingClientRect().height);
  const stored = () => page.evaluate((key) => localStorage.getItem(key), KEY);
  a.check('nothing is stored before the user resizes', (await stored()) === null, String(await stored()));

  // Drag the handle up by 150px: the editor shrinks.
  const before = await editorHeight();
  const handle = await page.evaluate(() => {
    const r = document.getElementById('editorTerminalResizeHandle').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(handle.x, handle.y);
  await page.mouse.down();
  await page.mouse.move(handle.x, handle.y - 150, { steps: 12 });
  await page.mouse.up();
  const savedOk = await page.waitForFunction((key) => localStorage.getItem(key) !== null, { timeout: 10_000 }, KEY)
    .then(() => true, () => false);
  const dims = JSON.parse((await stored()) ?? 'null');
  a.check('the drag stores the split under this session\'s key',
    savedOk && typeof dims?.editorPct === 'number' && dims.editorPct < 60,
    `stored=${JSON.stringify(dims)}`);
  const dragged = await editorHeight();
  a.check('the drag shrank the editor', before - dragged > 75, `editor ${before} -> ${dragged}`);

  // Drag the tree's edge right by 120px: the tree widens, and the width is stored.
  const treeWidth = () => page.evaluate(() => document.getElementById('treePanel').getBoundingClientRect().width);
  const treeBefore = await treeWidth();
  const edge = await page.evaluate(() => {
    const r = document.getElementById('treeResizeHandle').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x + 120, edge.y, { steps: 12 });
  await page.mouse.up();
  const widened = await treeWidth();
  const storedWidth = await page.waitForFunction(
    (key, width) => Math.abs((JSON.parse(localStorage.getItem(key) ?? 'null')?.treeWidth ?? -1) - width) <= 2,
    { timeout: 10_000 }, KEY, widened).then(() => true, () => false);
  a.check('dragging the tree edge widens the tree', widened - treeBefore > 60, `tree ${treeBefore} -> ${widened}`);
  a.check('the tree width is stored under this session\'s key', storedWidth,
    `stored=${await stored()} widened=${widened}`);

  // A reload lays the panes out at the stored split.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#editorTerminalResizeHandle', { visible: true, timeout: 30_000 });
  const restored = await page.waitForFunction(
    (target) => Math.abs(document.getElementById('editorPanel').getBoundingClientRect().height - target) <= 4,
    { timeout: 10_000 }, dragged).then(() => true, () => false);
  const after = await editorHeight();
  a.check('a reload restores the dragged split', restored, `editor after reload ${after}, dragged ${dragged}, default ${before}`);
  const treeRestored = await page.waitForFunction(
    (width) => Math.abs(document.getElementById('treePanel').getBoundingClientRect().width - width) <= 2,
    { timeout: 10_000 }, widened).then(() => true, () => false);
  a.check('a reload restores the dragged tree width', treeRestored,
    `tree after reload ${await treeWidth()}, widened ${widened}, default ${treeBefore}`);

  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
} finally {
  await browser.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
