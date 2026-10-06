#!/usr/bin/env bun
// monaco-polish/new/resize-persists-localStorage — a pane size the user
// drags is kept: dragging the editor↔terminal handle stores the new split
// under this session's key (nimbus.pane.dims./s/<sid>), and a reload of the
// page lays the panes out at that split again. Driven in a real Chrome.

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

  // A reload lays the panes out at the stored split.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#editorTerminalResizeHandle', { visible: true, timeout: 30_000 });
  const restored = await page.waitForFunction(
    (target) => Math.abs(document.getElementById('editorPanel').getBoundingClientRect().height - target) <= 4,
    { timeout: 10_000 }, dragged).then(() => true, () => false);
  const after = await editorHeight();
  a.check('a reload restores the dragged split', restored, `editor after reload ${after}, dragged ${dragged}, default ${before}`);

  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 2)));
} finally {
  await browser.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
