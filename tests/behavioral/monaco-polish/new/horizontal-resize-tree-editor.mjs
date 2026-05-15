#!/usr/bin/env bun
// monaco-polish/new/horizontal-resize-tree-editor — H1 handle
// (tree ↔ editor stack). HTML-shape assertions for handle + drag
// wiring; persistence covered by resize-persists-localStorage.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-polish/new/horizontal-resize-tree-editor');
console.log(`monaco-polish/new/horizontal-resize-tree-editor — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// DOM.
a.check('#treeResizeHandle in DOM',
  /id=["']treeResizeHandle["']/.test(html),
  `treeResizeHandle missing`);
a.check('.tree-resize-handle CSS rule sets col-resize cursor',
  /\.tree-resize-handle\s*\{[^}]*cursor:\s*col-resize/.test(html),
  `cursor rule missing`);
a.check('CSS hides tree-resize-handle outside editor mode (default display:none)',
  /\.tree-resize-handle\s*\{[^}]*display:\s*none/.test(html),
  `default-hide rule missing`);
a.check("CSS shows tree-resize-handle in .main.editor",
  /\.main\.editor\s+\.tree-resize-handle\s*\{[^}]*display:\s*block/.test(html),
  `editor-mode show rule missing`);

// JS wiring — PaneResizer binds the tree handle.
a.check('PaneResizer module declared',
  /const PaneResizer\s*=\s*\(function\(\)/.test(html),
  `PaneResizer IIFE missing`);
a.check("PaneResizer binds startDrag('tree', e) on tree handle",
  /treeResizeHandle[\s\S]{0,200}startDrag\(['"]tree['"]\s*,\s*e\)/.test(html),
  `tree-handle bind missing`);
a.check('Tree-drag clamps width to 160-600px',
  /Math\.max\(160,\s*Math\.min\(600,/.test(html),
  `tree clamp missing`);

// Drag updates panel-tree inline style.
a.check('Tree-drag updates panel-tree style.width',
  /onMove[\s\S]{0,400}treePanel[\s\S]{0,200}style\.width/.test(html),
  `width-mutation wiring missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
