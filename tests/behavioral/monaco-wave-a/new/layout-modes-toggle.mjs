#!/usr/bin/env bun
// monaco-wave-a/new/layout-modes-toggle — HTML structural assertion
// that new layout modes (editor-only, editor-bottom) are wired.
//
// Charter: "Update setLayout() (currently 3 modes ... → 5)"
// We assert the JS source contains all 5 mode handlers AND the CSS
// has the corresponding class rules.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/new/layout-modes-toggle');
console.log(`monaco-wave-a/new/layout-modes-toggle — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// JS handlers — onclick wiring for each of the 5 modes.
const modes = ['terminal-only', 'preview-only', 'split', 'editor-only', 'editor-bottom'];
for (const m of modes) {
  a.check(`setLayout('${m}') reference present`,
    new RegExp("setLayout\\(['\"]" + m + "['\"]\\)").test(html),
    `not found`);
}

// CSS — class rules for new modes.
a.check('.main.editor-only rule present',
  /\.main\.editor-only\b/.test(html),
  `.main.editor-only CSS missing`);
a.check('.main.editor-bottom rule present',
  /\.main\.editor-bottom\b/.test(html),
  `.main.editor-bottom CSS missing`);

// Editor panel DOM exists.
a.check('panel-editor DOM element present',
  /id=["']editorPanel["']/.test(html) && /class=["']panel-editor["']/.test(html),
  `editorPanel container missing`);

// Monaco container present (where the editor mounts).
a.check('#monaco-container present',
  /id=["']monaco-container["']/.test(html),
  `monaco-container missing`);

// Palette overlay present.
a.check('palette overlay DOM present',
  /id=["']paletteOverlay["']/.test(html) && /id=["']paletteInput["']/.test(html),
  `palette overlay missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
