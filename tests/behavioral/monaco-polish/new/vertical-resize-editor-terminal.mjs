// monaco-polish/new/vertical-resize-editor-terminal — V1 handle
// (editor TOP ↔ terminal BOTTOM, inside the editor-stack column), in a
// real Chrome: it shows with a row-resize cursor, and dragging it shrinks
// the editor pane and grows the terminal pane by the same amount, with
// both panes' inline flex basis updated.

import { mintSession, BASE, makeAsserter, deleteSession, readUntil } from '../../_driver.mjs';
import { grabHandle, launchBrowser, openPage } from '../../_runtime-behavioral-template.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/vertical-resize-editor-terminal');
console.log(`monaco-polish/new/vertical-resize-editor-terminal — ${process.env.BASE}`);

const sid = await mintSession();
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
      cursor: getComputedStyle(handle).cursor,
    };
  });

  const before = await measure();
  a.check('V1 handle visible in editor mode (display:block, has height)',
    before.handleVisible === true,
    JSON.stringify(before));
  a.check('V1 handle offers a row-resize cursor', before.cursor === 'row-resize', before.cursor);
  a.check('editor + terminal panes have non-zero height before drag',
    (before.editorH || 0) > 50 && (before.termH || 0) > 50,
    `editorH=${before.editorH} termH=${before.termH}`);

  // Drag the handle up by 150px: editor TOP shrinks, terminal BOTTOM grows.
  const dragPx = 150;
  const handle = await grabHandle(page, '#editorTerminalResizeHandle');
  await handle.move(0, -dragPx);
  await handle.release();
  const after = await readUntil(measure, (now) => before.editorH - now.editorH > dragPx * 0.5);
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
