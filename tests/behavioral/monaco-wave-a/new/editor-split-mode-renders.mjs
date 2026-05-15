#!/usr/bin/env bun
// monaco-wave-a/new/editor-split-mode-renders — editor-split mode
// puts the editor in the LEFT pane and preview in the RIGHT pane.
//
// HTML-shape assertions verify the layout-mode CSS class rules and
// JS wiring are present. Run-time activation is exercised by the
// monaco-vscode-features probe (which actually loads the editor).

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/new/editor-split-mode-renders');
console.log(`monaco-wave-a/new/editor-split-mode-renders — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// editor-split: editor LEFT + preview RIGHT (terminal hidden).
a.check('CSS hides .panel-terminal in editor-split mode',
  /\.main\.editor-split\s+\.panel-terminal\s*\{\s*display:\s*none/.test(html),
  `rule missing`);
a.check('CSS shows .panel-editor in editor-split mode',
  /\.main\.editor-split\s+\.panel-editor\s*\{[^}]*display:\s*flex/.test(html),
  `rule missing`);
a.check('CSS shows .panel-preview in editor-split mode',
  /\.main\.editor-split\s+\.panel-preview\s*\{[^}]*display:\s*flex/.test(html),
  `rule missing`);

// Toolbar button labeled for the new mode.
a.check('toolbar has Edit+Preview button (renamed)',
  /id=["']btnEditor["']\s+title=["']Editor \+ Preview/.test(html),
  `btnEditor title missing or wrong`);

// JS handler.
a.check('btnEditor onclick maps to editor-split mode',
  /setLayout\(['"]editor-split['"]\)/.test(html),
  `no setLayout('editor-split') in onclick wiring`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
