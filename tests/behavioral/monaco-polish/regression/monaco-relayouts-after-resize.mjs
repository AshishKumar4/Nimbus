#!/usr/bin/env bun
// monaco-polish/regression/monaco-relayouts-after-resize — Monaco's
// .layout() called after every drag end + mid-drag.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/regression/monaco-relayouts-after-resize');
console.log(`monaco-polish/regression/monaco-relayouts-after-resize — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

a.check('applyMonacoLayout helper calls editor.layout()',
  /function applyMonacoLayout[\s\S]{0,200}__nimbusMonacoEditor[\s\S]{0,100}\.layout\(\)/.test(html),
  `monaco-layout helper missing`);
a.check('endDrag calls applyMonacoLayout',
  /function endDrag[\s\S]{0,300}applyMonacoLayout/.test(html),
  `endDrag → applyMonacoLayout wiring missing`);
a.check('mid-drag onMove calls applyMonacoLayout',
  /onMove[\s\S]{0,1500}applyMonacoLayout/.test(html),
  `mid-drag monaco-layout missing`);

// Monaco config still has automaticLayout:true (belt + braces).
a.check('Monaco automaticLayout:true preserved',
  /automaticLayout:\s*true/.test(html),
  `automaticLayout regressed`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
