#!/usr/bin/env bun
// monaco-polish/regression/terminal-still-fits-after-resize —
// resize handlers call fitAddon.fit() after drag end + mid-drag,
// so the xterm always tracks the pane size.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/regression/terminal-still-fits-after-resize');
console.log(`monaco-polish/regression/terminal-still-fits-after-resize — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

a.check('applyTerminalFit helper calls fitAddon.fit()',
  /function applyTerminalFit[\s\S]{0,200}fitAddon\.fit\(\)/.test(html),
  `terminal-fit helper missing`);
a.check('endDrag calls applyTerminalFit',
  /function endDrag[\s\S]{0,300}applyTerminalFit/.test(html),
  `endDrag → applyTerminalFit wiring missing`);
a.check('mid-drag onMove calls applyTerminalFit (live shrink feel)',
  /onMove[\s\S]{0,1500}applyTerminalFit/.test(html),
  `mid-drag terminal-fit missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
