#!/usr/bin/env bun
// monaco-polish/new/resize-persists-localStorage — pane dims
// persisted via localStorage keyed per session.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/resize-persists-localStorage');
console.log(`monaco-polish/new/resize-persists-localStorage — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

a.check('LS key uses nimbus.pane.dims namespace',
  /nimbus\.pane\.dims/.test(html),
  `LS key missing`);
a.check('LS key includes SESSION_PREFIX (per-session persistence)',
  /nimbus\.pane\.dims[\s\S]{0,100}SESSION_PREFIX/.test(html),
  `per-session keying missing`);
a.check('dims structure: treeWidth + middlePct + editorPct',
  /treeWidth\s*:[\s\S]{0,100}middlePct\s*:[\s\S]{0,100}editorPct\s*:/.test(html),
  `dims object shape missing`);
a.check('localStorage.setItem on saveDims',
  /function saveDims[\s\S]{0,200}localStorage\.setItem/.test(html),
  `saveDims wiring missing`);
a.check('localStorage.getItem on loadDims',
  /function loadDims[\s\S]{0,200}localStorage\.getItem/.test(html),
  `loadDims wiring missing`);
a.check('saveDims called from endDrag',
  /function endDrag[\s\S]{0,300}saveDims\(\)/.test(html),
  `endDrag → saveDims wiring missing`);
a.check('restoreDims applies persisted tree width to DOM',
  /function restoreDims[\s\S]{0,300}treePanel[\s\S]{0,100}style\.width/.test(html) ||
  /function restoreDims[\s\S]{0,300}tree\.style\.width/.test(html),
  `restoreDims width application missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
