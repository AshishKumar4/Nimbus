#!/usr/bin/env bun
// monaco-wave-a/new/editor-split-with-terminal — 3-pane VSCode-style:
//   - Top-left: Monaco editor
//   - Bottom-left: terminal
//   - Right (full height): preview
//
// HTML-shape assertions cover the layout CSS + DOM wrapper + JS
// wiring. Verified post-deploy because the rules are inlined in the
// served HTML.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/new/editor-split-with-terminal');
console.log(`monaco-wave-a/new/editor-split-with-terminal — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// DOM: the .panel-left-stack wrapper holds editor + terminal so they
// can stack vertically in 3-pane mode without re-mounting nodes.
a.check('.panel-left-stack wrapper present in DOM',
  /class=["']panel-left-stack["']/.test(html),
  `wrapper missing`);

// CSS: stack becomes display:flex flex-direction:column ONLY in
// editor-split-with-term mode. In other modes it's display:contents
// (layout-transparent).
a.check('panel-left-stack default = display:contents (transparent)',
  /\.panel-left-stack\s*\{[^}]*display:\s*contents/.test(html),
  `default display:contents rule missing`);
a.check('panel-left-stack flips to flex column in editor-split-with-term',
  /\.main\.editor-split-with-term\s+\.panel-left-stack\s*\{[^}]*display:\s*flex/.test(html) &&
  /\.main\.editor-split-with-term\s+\.panel-left-stack\s*\{[^}]*flex-direction:\s*column/.test(html),
  `column-stack rule missing`);

// All 3 panes visible in this mode.
a.check('editor pane shown in editor-split-with-term',
  /\.main\.editor-split-with-term\s+\.panel-editor\s*\{[^}]*display:\s*flex/.test(html),
  `rule missing`);
a.check('terminal pane shown in editor-split-with-term',
  /\.main\.editor-split-with-term\s+\.panel-terminal\s*\{[^}]*display:\s*flex/.test(html),
  `rule missing`);
a.check('preview pane shown in editor-split-with-term',
  /\.main\.editor-split-with-term\s+\.panel-preview\s*\{[^}]*display:\s*flex/.test(html),
  `rule missing`);

// Toolbar wiring.
a.check('btnEditorTerm onclick maps to editor-split-with-term',
  /setLayout\(['"]editor-split-with-term['"]\)/.test(html),
  `no setLayout('editor-split-with-term') wiring`);
a.check('btnEditorTerm label updated for 3-pane semantic',
  /id=["']btnEditorTerm["']\s+title=["']Editor \+ Terminal \+ Preview/.test(html),
  `title missing or stale`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
