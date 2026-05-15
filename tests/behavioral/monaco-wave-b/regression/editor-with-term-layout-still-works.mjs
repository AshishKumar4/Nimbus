#!/usr/bin/env bun
// monaco-wave-b/regression/editor-with-term-layout-still-works —
// the editor + terminal + preview layout from Wave-A is preserved
// (just renamed editor-split-with-term → editor). Now ALSO has
// the file tree as a 4th pane (covered by file-tree-renders).

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/regression/editor-with-term-layout-still-works');
console.log(`monaco-wave-b/regression/editor-with-term-layout-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// .main.editor shows editor + terminal + preview (3 of the 4 panes;
// tree is the 4th, covered separately).
a.check('.main.editor shows panel-editor',
  /\.main\.editor\s+\.panel-editor\s*\{[^}]*display:\s*flex/.test(html),
  `editor visibility rule missing`);
a.check('.main.editor shows panel-terminal',
  /\.main\.editor\s+\.panel-terminal\s*\{[^}]*display:\s*flex/.test(html),
  `terminal visibility rule missing`);
a.check('.main.editor shows panel-preview',
  /\.main\.editor\s+\.panel-preview\s*\{[^}]*display:\s*flex/.test(html),
  `preview visibility rule missing`);

// editor + terminal still stack vertically (flex column).
a.check('.main.editor panel-left-stack flex column',
  /\.main\.editor\s+\.panel-left-stack\s*\{[^}]*display:\s*flex/.test(html) &&
  /\.main\.editor\s+\.panel-left-stack\s*\{[^}]*flex-direction:\s*column/.test(html),
  `vertical stack rule missing`);

// .panel-left-stack DOM still exists.
a.check('.panel-left-stack DOM wrapper present',
  /class=["']panel-left-stack["']/.test(html),
  `wrapper DOM missing`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
