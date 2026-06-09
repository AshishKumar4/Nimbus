#!/usr/bin/env bun
// monaco-polish/new/horizontal-resize-editor-preview — H2 handle resizes the
// center workspace column against preview.

import { mintSession, BASE, makeAsserter, requestHeaders } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/horizontal-resize-editor-preview');
console.log(`monaco-polish/new/horizontal-resize-editor-preview — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow', headers: requestHeaders() });
const html = await r.text();

a.check('#resizeHandle DOM still present',
  /id=["']resizeHandle["']/.test(html),
  `resizeHandle missing`);

a.check("PaneResizer binds startDrag('middle', e) for #resizeHandle",
  /h2\s*=\s*document\.getElementById\(['"]resizeHandle['"]\)[\s\S]{0,300}h2\.addEventListener\(['"]mousedown['"]\s*,\s*\(e\)\s*=>\s*startDrag\(['"]middle['"]\s*,\s*e\)\)/.test(html),
  `middle-handle bind missing`);

a.check('applyMiddlePreviewFlex updates center stack flex',
  /function applyMiddlePreviewFlex\(\)[\s\S]{0,500}stack\.style\.flex\s*=/.test(html),
  `leftStack flex mutation missing`);

a.check('applyMiddlePreviewFlex updates preview flex',
  /function applyMiddlePreviewFlex\(\)[\s\S]{0,500}prev\.style\.flex\s*=/.test(html),
  `preview flex mutation missing`);

a.check('applyMiddlePreviewFlex no longer branches to legacy split mode',
  !/layout\s*===\s*['"]split['"]/.test(html),
  `split branch still present`);

a.check('Middle-handle clamps middlePct to 20-80',
  /Math\.max\(20,\s*Math\.min\(80,/.test(html),
  `middle clamp missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
