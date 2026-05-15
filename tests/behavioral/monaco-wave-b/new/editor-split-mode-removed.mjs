#!/usr/bin/env bun
// monaco-wave-b/new/editor-split-mode-removed — explicitly verify
// the Wave-A 'editor-split' mode is GONE. User: "I don't need
// 'edit + preview' at all".
//
// Asserts no toolbar button, no CSS rule, no setLayout call site.
// Single canonical 'editor' mode replaces the old duo.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/new/editor-split-mode-removed');
console.log(`monaco-wave-b/new/editor-split-mode-removed — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// No CSS rules for the removed modes.
a.check('NO .main.editor-split CSS rule',
  !/\.main\.editor-split\b(?!-with-term|\b)/.test(html.replace(/\.main\.editor-split-with-term\b/g, '__OLD__')),
  `editor-split CSS still present`);
a.check('NO .main.editor-split-with-term CSS rule (renamed to .main.editor)',
  !/\.main\.editor-split-with-term\b/.test(html),
  `editor-split-with-term CSS still present`);

// No setLayout call sites for old modes.
a.check("NO setLayout('editor-split') call sites",
  !/setLayout\(['"]editor-split['"]\)/.test(html),
  `setLayout('editor-split') still present`);
a.check("NO setLayout('editor-split-with-term') call sites",
  !/setLayout\(['"]editor-split-with-term['"]\)/.test(html),
  `setLayout('editor-split-with-term') still present`);

// New canonical mode IS wired.
a.check("setLayout('editor') wiring present",
  /setLayout\(['"]editor['"]\)/.test(html),
  `setLayout('editor') missing`);
a.check('.main.editor CSS rule present',
  /\.main\.editor\s+\.panel-tree\s*\{[^}]*display:\s*flex/.test(html),
  `.main.editor CSS missing`);

// No "Edit+Preview" button.
a.check('NO btnEditorTerm (renamed to single btnEditor)',
  !/id=["']btnEditorTerm["']/.test(html),
  `old btnEditorTerm still present`);
a.check('Toolbar button labeled "Editor" (single mode)',
  />Editor</.test(html) && !/Edit\+Preview/.test(html),
  `toolbar label missing or stale`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
