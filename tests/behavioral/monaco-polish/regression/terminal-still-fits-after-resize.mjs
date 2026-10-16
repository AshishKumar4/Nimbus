#!/usr/bin/env bun
// monaco-polish/regression/terminal-still-fits-after-resize — the session
// terminal's grid follows its pane while a resize handle is dragged and
// after it is released, in a real Chrome: narrowing the center column
// (editor↔preview handle) takes columns away, and raising the
// editor↔terminal handle adds rows. The terminal still runs a command after.

import { BASE, mintSession, deleteSession, makeAsserter } from '../../_driver.mjs';
import { grabHandle, launchBrowser, openPage, readUntil, waitForSessionTerminalText } from '../../_runtime-behavioral-template.mjs';

const a = makeAsserter('monaco-polish/regression/terminal-still-fits-after-resize');
const sid = await mintSession();
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForSessionTerminalText(page, /\$/, 60_000);
  // `term` is the shell's session terminal.
  const grid = () => page.evaluate(() => ({ cols: term.cols, rows: term.rows }));
  const start = await grid();

  const middle = await grabHandle(page, '#resizeHandle');
  await middle.move(-200, 0);
  const held = await readUntil(grid, (now) => now.cols < start.cols);
  await middle.release();
  const released = await grid();
  a.check('narrowing the center column takes terminal columns away while held', held.cols < start.cols, JSON.stringify({ start, held }));
  a.check('and they stay away once released', released.cols < start.cols, JSON.stringify({ start, released }));

  const vertical = await grabHandle(page, '#editorTerminalResizeHandle');
  await vertical.move(0, -150);
  const raised = await readUntil(grid, (now) => now.rows > released.rows);
  await vertical.release();
  const settled = await grid();
  a.check('raising the editor↔terminal handle adds terminal rows while held', raised.rows > released.rows, JSON.stringify({ released, raised }));
  a.check('and they stay once released', settled.rows > released.rows, JSON.stringify({ released, settled }));

  await page.click('#terminal-container');
  await page.keyboard.type('echo FITTED_$((6*7))\n');
  await waitForSessionTerminalText(page, /FITTED_42/, 30_000);
  a.check('the resized terminal runs a command and shows its output', true);
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
