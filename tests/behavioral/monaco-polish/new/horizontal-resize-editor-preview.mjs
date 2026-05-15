#!/usr/bin/env bun
// monaco-polish/new/horizontal-resize-editor-preview — H2 handle
// (middle column ↔ preview). The existing #resizeHandle was already
// in split mode; monaco-polish makes it mode-aware so it adjusts
// .panel-left-stack ↔ .panel-preview in editor mode.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/horizontal-resize-editor-preview');
console.log(`monaco-polish/new/horizontal-resize-editor-preview — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

a.check('#resizeHandle DOM still present',
  /id=["']resizeHandle["']/.test(html),
  `resizeHandle missing`);

a.check("PaneResizer binds startDrag('middle', e) on #resizeHandle",
  /resizeHandle[\s\S]{0,200}startDrag\(['"]middle['"]\s*,\s*e\)/.test(html),
  `middle-handle bind missing`);

// applyMiddlePreviewFlex dispatches by layout: split → terminal+preview,
// editor → left-stack+preview.
a.check('applyMiddlePreviewFlex branches by layout',
  /applyMiddlePreviewFlex[\s\S]{0,1000}layout\s*===\s*['"]editor['"][\s\S]{0,400}layout\s*===\s*['"]split['"]/.test(html),
  `mode-aware branching missing`);

a.check('Editor-mode branch updates leftStack flex',
  /layout\s*===\s*['"]editor['"][\s\S]{0,300}leftStack[\s\S]{0,100}style\.flex/.test(html) ||
  /layout\s*===\s*['"]editor['"][\s\S]{0,300}stack\.style\.flex/.test(html),
  `leftStack flex mutation missing`);

a.check('Split-mode branch updates panel-terminal flex',
  /layout\s*===\s*['"]split['"][\s\S]{0,400}panel-terminal[\s\S]{0,100}style\.flex/.test(html) ||
  /layout\s*===\s*['"]split['"][\s\S]{0,400}term\.style\.flex/.test(html),
  `panel-terminal flex mutation missing`);

a.check('Middle-handle clamps middlePct to 20-80',
  /Math\.max\(20,\s*Math\.min\(80,/.test(html),
  `middle clamp missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
