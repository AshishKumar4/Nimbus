#!/usr/bin/env bun
// monaco-wave-b/regression/monaco-vscode-features-preserved —
// Wave-A's VSCode-grade Monaco config must remain intact after the
// Wave-B layout changes.
//
// Mirrors a subset of monaco-wave-a/new/monaco-vscode-features.mjs;
// if Wave-B's edits accidentally dropped the upgraded config, this
// fails loudly.

import { mintSession, BASE, makeAsserter } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('monaco-wave-b/regression/monaco-vscode-features-preserved');
console.log(`monaco-wave-b/regression/monaco-vscode-features-preserved — ${process.env.BASE}`);

const sid = await mintSession();
const r = await fetch(`${BASE}/s/${sid}/`, { redirect: 'follow' });
const html = await r.text();

const checks = [
  ['minimap enabled',          /minimap:\s*\{[^}]*enabled:\s*true/],
  ['bracketPairColorization',  /bracketPairColorization:\s*\{[^}]*enabled:\s*true/],
  ['guides bracketPairs',      /guides:\s*\{[^}]*bracketPairs:\s*['"]active['"]/],
  ['autoIndent full',          /autoIndent:\s*['"]full['"]/],
  ['formatOnPaste true',       /formatOnPaste:\s*true/],
  ['formatOnType true',        /formatOnType:\s*true/],
  ['smoothScrolling true',     /smoothScrolling:\s*true/],
  ['stickyScroll enabled',     /stickyScroll:\s*\{[^}]*enabled:\s*true/],
  ['tabSize 2',                /tabSize:\s*2\b/],
  ['fontFamily Menlo first',   /fontFamily:\s*["']Menlo[^"']*Monaco/],
  ['fontSize 14',              /fontSize:\s*14\b/],
  ['automaticLayout true',     /automaticLayout:\s*true/],
  ['theme vs-dark',            /theme:\s*['"]vs-dark['"]/],
];
for (const [name, re] of checks) {
  a.check('Monaco config: ' + name, re.test(html), `regex didn't match: ${re}`);
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
