#!/usr/bin/env bun
// monaco-polish/new/resize-survives-lost-capture — a workspace handle held
// by the pointer keeps following it when the page loses the pointer's
// capture mid-drag, and the drag ends only when the pointer is released.
import { BASE, mintSession, deleteSession, makeAsserter, readUntil } from '../../_driver.mjs';
import { grabHandle, launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

const a = makeAsserter('monaco-polish/new/resize-survives-lost-capture');
const sid = await mintSession();
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#treeResizeHandle', { visible: true, timeout: 30_000 });
  const width = () => page.$eval('#treePanel', (tree) => tree.getBoundingClientRect().width);
  const start = await width();

  const handle = await grabHandle(page, '#treeResizeHandle');
  await handle.move(40, 0);
  const held = await readUntil(width, (now) => now > start + 20);
  // The capture goes, the pointer stays down.
  await page.evaluate(() => {
    const element = document.getElementById('treeResizeHandle');
    for (const id of [1, 0]) if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
  });
  await handle.move(140, 0);
  const after = await readUntil(width, (now) => now > held + 60);
  a.check('the drag follows the pointer after its capture is lost', after > held + 60, `${start} -> ${held} -> ${after}`);
  await handle.release();
  await page.mouse.move(handle.x + 240, handle.y, { steps: 5 });
  const released = await width();
  a.check('and ends when the pointer is released', Math.abs(released - after) <= 1, `${after} -> ${released}`);

  // Its capture lost, released over the preview's frame, where this page hears nothing:
  // moving back without a press resizes nothing, and the next press starts a drag.
  const frame = await (await page.waitForSelector('#previewPanel', { visible: true, timeout: 30_000 })).boundingBox();
  const again = await grabHandle(page, '#treeResizeHandle');
  await page.evaluate(() => {
    const element = document.getElementById('treeResizeHandle');
    for (const id of [1, 0]) if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
  });
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2, { steps: 10 });
  await again.release();
  const dropped = await width();
  await page.mouse.move(again.x + 30, again.y, { steps: 5 });
  a.check('a release the page did not hear ends the drag at the next move', Math.abs(await width() - dropped) <= 1, `${dropped} -> ${await width()}`);
  const next = await grabHandle(page, '#treeResizeHandle');
  await next.move(-60, 0);
  const moved = await readUntil(width, (now) => now < dropped - 30);
  await next.release();
  a.check('and the next press starts a drag', moved < dropped - 30, `${dropped} -> ${moved}`);
  a.check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
  await browser.close();
  await deleteSession(sid);
}
const result = a.summary();
process.exit(result.fail ? 1 : 0);
