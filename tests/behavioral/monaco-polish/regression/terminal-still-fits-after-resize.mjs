#!/usr/bin/env bun
// monaco-polish/regression/terminal-still-fits-after-resize — the session
// terminal's grid fits its pane while a resize handle is dragged and after
// it is released, in a real Chrome: narrowing the center column
// (editor↔preview handle) takes columns away, raising the editor↔terminal
// handle adds rows, and each time the grid is the one the fit addon
// measures for the pane as it is then. The terminal still runs a command
// after.

import { BASE, mintSession, deleteSession, makeAsserter, readUntil } from '../../_driver.mjs';
import { grabHandle, launchBrowser, openPage, waitForSessionTerminalText } from '../../_runtime-behavioral-template.mjs';

const a = makeAsserter('monaco-polish/regression/terminal-still-fits-after-resize');
const sid = await mintSession();
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await waitForSessionTerminalText(page, /\$/, 60_000);
  // `term` is the shell's session terminal and `fitAddon` its fit addon:
  // `fits` is whether the grid is what the pane holds now.
  const grid = () => page.evaluate(() => {
    const proposed = fitAddon.proposeDimensions();
    return { cols: term.cols, rows: term.rows, fits: proposed !== undefined && proposed.cols === term.cols && proposed.rows === term.rows };
  });
  const start = await grid();

  const middle = await grabHandle(page, '#resizeHandle');
  await middle.move(-200, 0);
  const held = await readUntil(grid, (now) => now.cols < start.cols && now.fits);
  await middle.release();
  const released = await readUntil(grid, (now) => now.fits);
  a.check('narrowing the center column refits the terminal to fewer columns while held', held.cols < start.cols && held.fits, JSON.stringify({ start, held }));
  a.check('and it fits the pane once released', released.cols < start.cols && released.fits, JSON.stringify({ start, released }));

  const vertical = await grabHandle(page, '#editorTerminalResizeHandle');
  await vertical.move(0, -150);
  const raised = await readUntil(grid, (now) => now.rows > released.rows && now.fits);
  await vertical.release();
  const settled = await readUntil(grid, (now) => now.fits);
  a.check('raising the editor↔terminal handle refits the terminal to more rows while held', raised.rows > released.rows && raised.fits, JSON.stringify({ released, raised }));
  a.check('and it fits the pane once released', settled.rows > released.rows && settled.fits, JSON.stringify({ released, settled }));

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
