#!/usr/bin/env bun
// monaco-polish/regression/monaco-relayouts-after-resize — the editor
// fills its pane while a resize handle is dragged and after it is
// released, in a real Chrome: Monaco's layout follows the container when
// the center column narrows (editor↔preview handle) and when the editor
// pane shortens (editor↔terminal handle), and the file stays readable.

import { BASE, mintSession, deleteSession, makeAsserter, requestHeaders } from '../../_driver.mjs';
import { grabHandle, launchBrowser, openPage, readUntil } from '../../_runtime-behavioral-template.mjs';
import { Nimbus } from '../../../../packages/sdk/src/index.ts';

const a = makeAsserter('monaco-polish/regression/monaco-relayouts-after-resize');
const sid = await mintSession();
const box = Nimbus.connect({ endpoint: BASE, headers: () => requestHeaders({}, sid) }).sandbox(sid);
const path = '/home/user/relayout.js';
const browser = await launchBrowser();
try {
  await box.files.write(path, 'export const relayout = true;\n');
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => window.__nimbusMonacoEditor, { timeout: 60_000 });
  await page.locator(`.tree-node[data-path="${path}"]`).click();
  await page.waitForFunction(() => window.__nimbusMonacoEditor.getValue().startsWith('export const relayout'), { timeout: 30_000 });

  // The editor's laid-out size against its container's.
  const fit = () => page.evaluate(() => {
    const layout = window.__nimbusMonacoEditor.getLayoutInfo();
    const container = document.getElementById('monaco-container');
    return { width: layout.width, height: layout.height, containerWidth: container.clientWidth, containerHeight: container.clientHeight };
  });
  const fills = (now) => Math.abs(now.width - now.containerWidth) <= 2 && Math.abs(now.height - now.containerHeight) <= 2;
  const start = await fit();
  a.check('the editor fills its pane before any drag', fills(start), JSON.stringify(start));

  const middle = await grabHandle(page, '#resizeHandle');
  await middle.move(-200, 0);
  const narrowed = await readUntil(fit, (now) => now.width < start.width - 100 && fills(now));
  a.check('narrowing the center column narrows the editor with its pane while held', narrowed.width < start.width - 100 && fills(narrowed), JSON.stringify({ start, narrowed }));
  await middle.release();
  const released = await readUntil(fit, fills);
  a.check('and it still fills the pane once released', fills(released) && released.width < start.width - 100, JSON.stringify(released));

  const vertical = await grabHandle(page, '#editorTerminalResizeHandle');
  await vertical.move(0, -150);
  const shortened = await readUntil(fit, (now) => now.height < released.height - 75 && fills(now));
  a.check('shortening the editor pane shortens the editor while held', shortened.height < released.height - 75 && fills(shortened), JSON.stringify({ released, shortened }));
  await vertical.release();
  const settled = await readUntil(fit, fills);
  a.check('and it still fills the pane once released', fills(settled), JSON.stringify(settled));

  const shown = await page.$eval('#editorPanel .view-lines', (lines) => lines.textContent);
  a.check('the resized editor still renders the file', shown.includes('export const relayout'), JSON.stringify(shown.slice(0, 120)));
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
