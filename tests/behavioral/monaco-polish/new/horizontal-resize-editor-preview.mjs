#!/usr/bin/env bun
// monaco-polish/new/horizontal-resize-editor-preview — the editor↔preview
// handle, dragged in a real Chrome: it offers a column-resize cursor, the
// center column and the preview trade width while it is held, and the
// center keeps between 20% and 80% of the pair however far it is dragged.

import { BASE, mintSession, deleteSession, makeAsserter, readUntil } from '../../_driver.mjs';
import { grabHandle, launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

const a = makeAsserter('monaco-polish/new/horizontal-resize-editor-preview');
const sid = await mintSession();
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#resizeHandle', { visible: true, timeout: 30_000 });
  a.check('the handle offers a column-resize cursor',
    await page.$eval('#resizeHandle', (handle) => getComputedStyle(handle).cursor) === 'col-resize');
  // The center column's and the preview's widths, and the center's share of the pair as its flex sets it.
  const widths = () => page.evaluate(() => {
    const center = document.getElementById('leftStack');
    const preview = document.getElementById('previewPanel');
    const grow = (element) => Number.parseFloat(element.style.flexGrow || getComputedStyle(element).flexGrow);
    return {
      center: center.getBoundingClientRect().width,
      preview: preview.getBoundingClientRect().width,
      centerPct: (100 * grow(center)) / (grow(center) + grow(preview)),
    };
  });
  const start = await widths();

  const handle = await grabHandle(page, '#resizeHandle');
  await handle.move(-150, 0);
  const held = await readUntil(widths, (now) => now.center < start.center - 100);
  const traded = start.center - held.center;
  a.check('the center narrows and the preview widens by as much while it is held',
    traded > 100 && Math.abs((held.preview - start.preview) - traded) <= 4, JSON.stringify({ start, held }));
  // To the viewport's edges (1280 px wide), the drag's farthest reach each way.
  await handle.move(1 - handle.x, 0);
  const leftmost = await readUntil(widths, (now) => Math.abs(now.centerPct - 20) < 0.5);
  await handle.move(1279 - handle.x, 0);
  const rightmost = await readUntil(widths, (now) => Math.abs(now.centerPct - 80) < 0.5);
  await handle.release();
  a.check('dragged far left, the center keeps 20% of the pair', Math.abs(leftmost.centerPct - 20) < 0.5, JSON.stringify(leftmost));
  a.check('dragged far right, the center keeps 80% of the pair', Math.abs(rightmost.centerPct - 80) < 0.5, JSON.stringify(rightmost));
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
