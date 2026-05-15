#!/usr/bin/env bun
// file-tree-watch/regression/monaco-polish-resize-preserved — the
// PaneResizer + 3 resize handles from monaco-polish still ship.
// Wave didn't touch resize logic; this guards against accidental
// IIFE-shape damage that could break the layout JS.

import { mintSession, makeAsserter, BASE } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('file-tree-watch/regression/monaco-polish-resize-preserved');
console.log(`file-tree-watch/regression/monaco-polish-resize-preserved — ${BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`);
a.check('GET /s/<sid>/ returns 200', r.status === 200, `status=${r.status}`);
const html = await r.text();

// monaco-polish markers: PaneResizer, the 3 handles.
a.check('html still has PaneResizer marker',
  html.includes('PaneResizer'),
  '');
a.check('html still has H1/H2/H3 handle markers',
  html.includes('TreeResizeHandle') || html.includes('treeResizeHandle') || html.includes('resizeHandle'),
  '');
a.check('html still has localStorage persistence calls',
  /localStorage\.(get|set)Item\([^)]*nimbus/.test(html) || html.includes('nimbus.tree'),
  '');

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
