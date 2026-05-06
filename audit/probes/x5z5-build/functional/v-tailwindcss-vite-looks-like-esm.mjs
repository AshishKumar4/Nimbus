#!/usr/bin/env bun
// X.5-Z5 functional — looksLikeEsm regex catches minified ESM shape
// where ;import{ or ;export{ appear after a `;` on the same line.
//
// Per X5Z5-plan.md §3.1, the current regexes at
// src/facet-manager.ts:772 + 774 have TWO blind spots:
//   (a) leading anchor `(^|\n)` rejects `;import` / `}import`.
//   (b) `\s+` after `import|export` rejects no-whitespace `import{`.
// Both relaxations are needed (single-relaxation fix is half-broken).
//
// PRE-FIX: red — fails on minified ESM, fails on no-whitespace ESM.
// POST-FIX: green — both shapes detected, AND the false-positive guard
// for `var importedX = 1;` still rejects (the next char after `import`
// is `e`, not in `[\s{]`).
//
// We import looksLikeEsm via the function the source actually uses. The
// function is module-private to facet-manager.ts; we mirror its current
// implementation via dynamic-import-then-extract trick: facet-manager.ts
// also exports a `transformEsmInBundle` that calls looksLikeEsm. The
// cleanest TDD strategy is a parallel inline implementation that quotes
// the source verbatim — so that when the source changes, we re-quote.
//
// Implementation choice: read src/facet-manager.ts, regex-extract the
// looksLikeEsm function body, eval it in a fresh function scope, and
// run the test cases. This is exactly the same pattern as
// audit/probes/x5z5-investigation/run-checks.cjs (test 5 / 6) but
// extracts the live source instead of inlining.

import { ok, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FM = path.resolve(HERE, '..', '..', '..', '..', 'src', 'facet-manager.ts');

const src = fs.readFileSync(FM, 'utf8');

// Pull the body of `function looksLikeEsm(...)`.
const match = src.match(/function\s+looksLikeEsm\s*\([^)]*\)\s*:\s*boolean\s*\{([\s\S]*?)\n\}/);
if (!match) {
  console.log('NOT OK: cannot locate looksLikeEsm in src/facet-manager.ts');
  process.exit(1);
}
const body = match[1];

// Re-instantiate as a JS function. The body uses `src.replace(...)`
// internally, so we keep the parameter name `src` — but to avoid colliding
// with the outer `src` variable, rename in the eval scope.
const looksLikeEsm = new Function('input',
  `const src = input;\n${body.replace(/:\s*string/g, '').replace(/:\s*boolean/g, '')}\n`
);

// Test fixtures from X5Z5-plan.md §3.1 + run-checks.cjs:
const cases = {
  // Minified ESM with `;import{` after var initializers (the dominant
  // shape in @tailwindcss/vite/dist/index.mjs).
  minifiedSemicolonImport:
    'var C=1,D=2;import{compile as M}from"@tailwindcss/node";function f(){return 1};export{f as default};',
  // No-whitespace single-line ESM.
  noWhitespaceImport:
    'import{compile as M}from"@tailwindcss/node";export{f as default};',
  // Newline-anchored ESM (must STILL be caught — regression safety).
  newlineEsm:
    'import x from "y";\nexport default x;\n',
  // Plain CJS — must NOT be detected (regression safety).
  plainCjs:
    'const x = require("y");\nmodule.exports = {};\n',
  // False-positive trap from X5Z5-plan.md §3.2: `importedX` is an
  // identifier, not the `import` keyword. The fix `[\s{]` after import
  // keeps this rejected (next char is `e` ∉ `[\s{]`).
  importedIdentifier:
    'var importedX = 1; var exportable = {};\n',
  // Comment lines that LOOK like import (must NOT be detected).
  commentImport:
    '// import x from "y";\n/* export default 1; */\n',
};

ok('looksLikeEsm DETECTS minified ;import{} (Z5 regex blind-spot A+B)',
  looksLikeEsm(cases.minifiedSemicolonImport) === true);

ok('looksLikeEsm DETECTS no-whitespace import{ (blind-spot B)',
  looksLikeEsm(cases.noWhitespaceImport) === true);

// REGRESSION cases:
ok('looksLikeEsm REGRESSION: still detects newline ESM',
  looksLikeEsm(cases.newlineEsm) === true);
ok('looksLikeEsm REGRESSION: rejects plain CJS',
  looksLikeEsm(cases.plainCjs) === false);
ok('looksLikeEsm REGRESSION: rejects "importedX" identifier (no false positive)',
  looksLikeEsm(cases.importedIdentifier) === false);
ok('looksLikeEsm REGRESSION: rejects comment-only "// import"',
  looksLikeEsm(cases.commentImport) === false);

summary('v-tailwindcss-vite-looks-like-esm');
