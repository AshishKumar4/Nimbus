#!/usr/bin/env bun
// monaco-wave-a/regression/existing-layout-modes-still-work — the
// pre-existing terminal-only / preview-only / split modes must
// remain toggleable. Wave-A added two new modes; this asserts the
// original three are still wired.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/regression/existing-layout-modes-still-work');
console.log(`monaco-wave-a/regression/existing-layout-modes-still-work — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// Original toolbar buttons still wired.
for (const id of ['btnTerminal', 'btnPreview', 'btnSplit']) {
  a.check(`#${id} button still present`,
    new RegExp(`id=["']${id}["']`).test(html),
    `#${id} missing`);
}

// Original onclick handlers (setLayout strings) still present.
for (const m of ['terminal-only', 'preview-only', 'split']) {
  a.check(`setLayout('${m}') still wired`,
    new RegExp("setLayout\\(['\"]" + m + "['\"]\\)").test(html),
    `setLayout('${m}') missing`);
}

// Original panels present: terminal, preview, resize handle.
a.check('panel-terminal panel present', /class=["']panel-terminal["']/.test(html), 'missing');
a.check('panel-preview panel present', /class=["']panel-preview["']/.test(html), 'missing');
a.check('resize-handle present', /id=["']resizeHandle["']/.test(html), 'missing');

// Original CSS rules preserved.
a.check('.main.terminal-only CSS present',
  /\.main\.terminal-only\b/.test(html), 'missing');
a.check('.main.preview-only CSS present',
  /\.main\.preview-only\b/.test(html), 'missing');

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
