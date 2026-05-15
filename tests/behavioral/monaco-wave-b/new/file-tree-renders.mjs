#!/usr/bin/env bun
// monaco-wave-b/new/file-tree-renders — file-tree panel + module wired.
//
// HTML-shape assertions: the .panel-tree DOM, the FileTree IIFE,
// the toolbar buttons, the search input, and the WS handler hookup
// must all be present in the served page.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/new/file-tree-renders');
console.log(`monaco-wave-b/new/file-tree-renders — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// DOM.
a.check('panel-tree DOM element present',
  /id=["']treePanel["']/.test(html) && /class=["']panel-tree["']/.test(html),
  `treePanel missing`);
a.check('tree-body container present',
  /id=["']treeBody["']/.test(html),
  `treeBody missing`);
a.check('tree-search input present',
  /id=["']treeSearch["']/.test(html),
  `treeSearch missing`);
a.check('tree-resize-handle present',
  /id=["']treeResizeHandle["']/.test(html),
  `treeResizeHandle missing`);
// Toolbar buttons.
a.check('New File button present',
  /id=["']btnTreeNewFile["']/.test(html),
  `btnTreeNewFile missing`);
a.check('New Folder button present',
  /id=["']btnTreeNewDir["']/.test(html),
  `btnTreeNewDir missing`);
a.check('Refresh button present',
  /id=["']btnTreeRefresh["']/.test(html),
  `btnTreeRefresh missing`);

// JS module.
a.check('FileTree IIFE module declared',
  /const FileTree\s*=\s*\(function\(\)/.test(html),
  `FileTree module not declared`);
a.check('FileTree.tryHandleFsResult wired into WS onmessage',
  /FileTree\.tryHandleFsResult\(msg\)/.test(html),
  `FileTree WS hook missing`);
a.check('FileTree.ensureLoaded called when entering editor mode',
  /wantEditor[\s\S]{0,200}FileTree\.ensureLoaded\(\)/.test(html),
  `FileTree lazy-load wiring missing`);

// CSS — tree visible only in editor mode.
a.check('CSS .main.editor .panel-tree { display:flex }',
  /\.main\.editor\s+\.panel-tree\s*\{[^}]*display:\s*flex/.test(html),
  `tree shown rule missing`);
a.check('CSS panel-tree default display:none',
  /\.panel-tree\s*\{[^}]*display:\s*none/.test(html),
  `tree default-hide rule missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
