#!/usr/bin/env bun
// monaco-wave-a/new/monaco-themed-properly — VSCode-equivalent
// styling: dark theme, font, status bar, editor chrome.
//
// HTML-shape probe — verifies the CSS + inline JS ship the proper
// theming (the user said "current is useless — make it nice").

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/new/monaco-themed-properly');
console.log(`monaco-wave-a/new/monaco-themed-properly — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// CSS — panel background matches VSCode (#1e1e1e).
a.check('panel-editor background #1e1e1e (VSCode dark)',
  /\.panel-editor\s*\{[^}]*background:\s*#1e1e1e/.test(html),
  `panel-editor background wrong`);

// CSS — bottom status bar with VSCode blue (#007acc).
a.check('editor-statusbar uses VSCode blue (#007acc)',
  /\.editor-statusbar\s*\{[^}]*background:\s*#007acc/.test(html),
  `statusbar color missing`);
a.check('editor-statusbar DOM element present',
  /id=["']editorStatusBar["']/.test(html),
  `statusbar DOM missing`);
a.check('statusbar position element present',
  /id=["']editorStatusPos["']/.test(html),
  `Ln/Col element missing`);
a.check('statusbar language element present',
  /id=["']editorStatusLang["']/.test(html),
  `language element missing`);

// Cursor position handler wires status bar updates.
a.check('onDidChangeCursorPosition wired to statusbar',
  /onDidChangeCursorPosition\(\(e\)\s*=>\s*\{[^}]*statusPos/.test(html),
  `cursor-pos handler not wired`);
a.check('onDidChangeModelLanguage wired to statusbar',
  /onDidChangeModelLanguage\(\(e\)\s*=>\s*\{[^}]*statusLang/.test(html),
  `language-change handler not wired`);

// Font configured properly (Menlo/Monaco/Consolas — VSCode default
// chain on macOS/Linux/Windows respectively).
a.check('font chain leads with Menlo',
  /fontFamily:\s*["']Menlo[^"']*Monaco/.test(html),
  `font chain wrong`);
a.check('font size 14 (VSCode default for editor)',
  /fontSize:\s*14\b/.test(html),
  `font size != 14`);

// Theme = vs-dark.
a.check('theme = vs-dark',
  /theme:\s*['"]vs-dark['"]/.test(html),
  `theme wrong`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
