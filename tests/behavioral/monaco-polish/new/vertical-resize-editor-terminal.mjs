#!/usr/bin/env bun
// monaco-polish/new/vertical-resize-editor-terminal — V1 handle
// (editor TOP ↔ terminal BOTTOM, inside the editor-stack column).
// Visible only in editor mode.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/vertical-resize-editor-terminal');
console.log(`monaco-polish/new/vertical-resize-editor-terminal — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// DOM.
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

// JS wiring.
a.check("PaneResizer binds startDrag('editor-terminal', e) on V1",
  /editorTerminalResizeHandle[\s\S]{0,300}startDrag\(['"]editor-terminal['"]\s*,\s*e\)/.test(html),
  `vresize bind missing`);

// applyEditorTerminalFlex updates editor + terminal flex basis.
a.check('applyEditorTerminalFlex updates panel-editor flex',
  /applyEditorTerminalFlex[\s\S]{0,400}editorPanel[\s\S]{0,100}style\.flex/.test(html) ||
  /applyEditorTerminalFlex[\s\S]{0,400}editor\.style\.flex/.test(html),
  `editor flex mutation missing`);
a.check('applyEditorTerminalFlex updates panel-terminal flex',
  /applyEditorTerminalFlex[\s\S]{0,500}panel-terminal[\s\S]{0,200}style\.flex/.test(html) ||
  /applyEditorTerminalFlex[\s\S]{0,500}term\.style\.flex/.test(html),
  `terminal flex mutation missing`);

a.check('vresize clamps editorPct to 10-90',
  /Math\.max\(10,\s*Math\.min\(90,/.test(html),
  `vresize clamp missing`);

a.check('vresize-drag triggers Monaco editor.layout()',
  /onMove[\s\S]{0,1200}__nimbusMonacoEditor[\s\S]{0,100}\.layout\(\)/.test(html) ||
  /applyMonacoLayout\b/.test(html),
  `Monaco-relayout-after-drag missing`);
a.check('vresize-drag triggers fitAddon.fit() (terminal)',
  /onMove[\s\S]{0,1200}fitAddon\.fit\(\)/.test(html) ||
  /applyTerminalFit\b/.test(html),
  `terminal-refit-after-drag missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
