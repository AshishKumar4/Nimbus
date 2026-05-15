#!/usr/bin/env bun
// monaco-wave-a/new/monaco-vscode-features — Monaco config is the
// full VSCode-like options object (not the bare initial config the
// first Wave-A draft shipped, which the user flagged as "useless").
//
// We assert the inlined JS contains the full feature set:
//   - minimap enabled (right side)
//   - line numbers on
//   - bracket pair colorization
//   - indent guides
//   - format on paste/type
//   - auto-indent / auto-close brackets
//   - smooth scrolling / smooth cursor
//   - sticky scroll
//   - tab size 2
//   - font 14px Menlo/Monaco/Consolas
//
// These options are deliberately verified at the source level
// (regex on the served HTML's inline JS) rather than via a real
// browser. A future puppeteer probe could exercise them at runtime.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-a/new/monaco-vscode-features');
console.log(`monaco-wave-a/new/monaco-vscode-features — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

// Required options.
const required = [
  // Minimap.
  { name: 'minimap enabled',         re: /minimap:\s*\{[^}]*enabled:\s*true/ },
  { name: 'minimap on right',        re: /minimap:\s*\{[^}]*side:\s*['"]right['"]/ },
  // Line numbers.
  { name: 'line numbers on',         re: /lineNumbers:\s*['"]on['"]/ },
  // Bracket pair colorization.
  { name: 'bracketPairColorization', re: /bracketPairColorization:\s*\{[^}]*enabled:\s*true/ },
  // Indent + bracket guides.
  { name: 'guides bracketPairs',     re: /guides:\s*\{[^}]*bracketPairs:\s*['"]active['"]/ },
  { name: 'guides indentation',      re: /guides:\s*\{[^}]*indentation:\s*true/ },
  // Auto-indent + auto-close brackets.
  { name: 'autoIndent full',         re: /autoIndent:\s*['"]full['"]/ },
  { name: 'autoClosingBrackets',     re: /autoClosingBrackets:\s*['"]languageDefined['"]/ },
  { name: 'autoClosingQuotes',       re: /autoClosingQuotes:\s*['"]languageDefined['"]/ },
  // Format on paste/type.
  { name: 'formatOnPaste',           re: /formatOnPaste:\s*true/ },
  { name: 'formatOnType',            re: /formatOnType:\s*true/ },
  // Smooth scrolling/cursor.
  { name: 'smoothScrolling',         re: /smoothScrolling:\s*true/ },
  { name: 'cursorSmoothCaret',       re: /cursorSmoothCaretAnimation:\s*['"]on['"]/ },
  // Sticky scroll (the floating-header-on-scroll feature VSCode added in 2023).
  { name: 'stickyScroll enabled',    re: /stickyScroll:\s*\{[^}]*enabled:\s*true/ },
  // Tab size 2 + insertSpaces.
  { name: 'tabSize 2',               re: /tabSize:\s*2\b/ },
  { name: 'insertSpaces true',       re: /insertSpaces:\s*true/ },
  // Font (Menlo/Monaco/Consolas first per real VSCode default).
  { name: 'fontFamily Menlo',        re: /fontFamily:\s*["'][^"']*\bMenlo\b/ },
  { name: 'fontSize 14',             re: /fontSize:\s*14\b/ },
  // automaticLayout (REQUIRED for split-pane resize — without this
  // the editor sees its initial container size forever).
  { name: 'automaticLayout true',    re: /automaticLayout:\s*true/ },
  // Theme.
  { name: 'theme vs-dark',           re: /theme:\s*['"]vs-dark['"]/ },
];

for (const { name, re } of required) {
  a.check(`Monaco config has: ${name}`, re.test(html), `regex didn't match: ${re}`);
}

// Negative: NO weak/bare config. Pre-fix the editor was just
// {value, language, theme, automaticLayout, minimap:{enabled:false},
// fontFamily, fontSize:13, wordWrap, scrollBeyondLastLine}. The
// minimap-disabled string would still be present in HISTORY but not
// in the live HTML. Specifically: minimap:{enabled:false} should
// NOT appear.
a.check('Monaco config no longer ships minimap disabled',
  !/minimap:\s*\{\s*enabled:\s*false\s*\}/.test(html),
  `minimap:{enabled:false} still in HTML`);

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
