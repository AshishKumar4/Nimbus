#!/usr/bin/env bun
// monaco-polish/new/vertical-resize-editor-terminal — V1 handle
// (editor TOP ↔ terminal BOTTOM, inside the editor-stack column).
// Visible only in editor mode.
//
// The flex mutation is asserted as OBSERVABLE behavior: a real Chrome
// drags the handle and we measure that the editor pane shrinks and the
// terminal pane grows by the same amount, with both panes' inline flex
// basis updated. Source-regex on the handler shape is brittle (the
// implementation assigns editorPanel to a `topSurface` local before
// setting .style.flex), so the behavioral charter's live check is the
// source of truth here.

import { mintSession, BASE, makeAsserter, requestHeaders, deleteSession } from '../../_driver.mjs';
import { launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/vertical-resize-editor-terminal');
console.log(`monaco-polish/new/vertical-resize-editor-terminal — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow', headers: requestHeaders() });
const html = await r.text();

// DOM + CSS structure (cheap static sanity; the live drag below proves
// the actual resize).
a.check('#editorTerminalResizeHandle in DOM',
  /id=["']editorTerminalResizeHandle["']/.test(html),
  `vresize handle missing`);
a.check('.vresize-handle CSS sets row-resize cursor',
  /\.vresize-handle\s*\{[^}]*cursor:\s*row-resize/.test(html),
  `cursor rule missing`);
a.check('.vresize-handle hidden by default',
  /\.vresize-handle\s*\{[^}]*display:\s*none/.test(html),
  `default-hide rule missing`);
a.check('.main.editor shows .vresize-handle',
  /\.main\.editor\s+\.vresize-handle\s*\{[^}]*display:\s*block/.test(html),
  `editor-mode show rule missing`);

// Live: the editor↔terminal vertical resize actually works.
const browser = await launchBrowser();
try {
  const { page, pageErrors } = await openPage(browser, sid);
  await page.goto(`${BASE}/s/${sid}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#editorTerminalResizeHandle', { timeout: 30_000 });

  const measure = () => page.evaluate(() => {
    const ed = document.getElementById('editorPanel');
    const term = document.querySelector('.panel-terminal');
    const handle = document.getElementById('editorTerminalResizeHandle');
    const hr = handle.getBoundingClientRect();
    return {
      editorH: ed ? ed.getBoundingClientRect().height : null,
      termH: term ? term.getBoundingClientRect().height : null,
      editorFlex: ed ? ed.style.flex : null,
      termFlex: term ? term.style.flex : null,
      handleVisible: getComputedStyle(handle).display === 'block' && hr.height > 0,
      hx: hr.x, hy: hr.y, hw: hr.width, hh: hr.height,
    };
  });

  const before = await measure();
  a.check('V1 handle visible in editor mode (display:block, has height)',
    before.handleVisible === true,
    JSON.stringify(before));
  a.check('editor + terminal panes have non-zero height before drag',
    (before.editorH || 0) > 50 && (before.termH || 0) > 50,
    `editorH=${before.editorH} termH=${before.termH}`);

  // Drag the handle up by 150px: editor TOP shrinks, terminal BOTTOM grows.
  const startX = before.hx + before.hw / 2;
  const startY = before.hy + before.hh / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY - 60, { steps: 6 });
  await page.mouse.move(startX, startY - 150, { steps: 12 });
  await page.mouse.up();
  await new Promise((res) => setTimeout(res, 300));

  const after = await measure();
  const dragPx = 150;
  const editorDelta = before.editorH - after.editorH;
  const termDelta = after.termH - before.termH;

  a.check('dragging V1 up shrinks the editor pane',
    editorDelta > dragPx * 0.5,
    `editorH ${before.editorH} -> ${after.editorH} (delta=${editorDelta})`);
  a.check('dragging V1 up grows the terminal pane',
    termDelta > dragPx * 0.5,
    `termH ${before.termH} -> ${after.termH} (delta=${termDelta})`);
  a.check('editor shrink == terminal growth (flex conservation within 2px)',
    Math.abs(editorDelta - termDelta) <= 2,
    `editorDelta=${editorDelta} termDelta=${termDelta}`);
  a.check('editorPanel inline flex basis updated by drag',
    /^\d/.test(String(after.editorFlex || '')) && after.editorFlex !== before.editorFlex,
    `editorFlex ${JSON.stringify(before.editorFlex)} -> ${JSON.stringify(after.editorFlex)}`);
  a.check('terminal pane inline flex basis updated by drag',
    /^\d/.test(String(after.termFlex || '')) && after.termFlex !== before.termFlex,
    `termFlex ${JSON.stringify(before.termFlex)} -> ${JSON.stringify(after.termFlex)}`);
  a.check('no page errors during resize',
    pageErrors.length === 0,
    JSON.stringify(pageErrors.slice(0, 2)));
} finally {
  await browser.close();
  await deleteSession(sid);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
