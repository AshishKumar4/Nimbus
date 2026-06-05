#!/usr/bin/env bun
// module-format/dot-mjs-as-esm — .mjs with template-string imports + TLA
// loads without "Identifier already declared" false-import collision.
//
// Root cause (audit 2026-05-11-sk-mjs-fix):
//
//   `convertEsmImportsToRequire` in src/runtime/esbuild-service.ts:393
//   scans the (esbuild ESM-pass-1) source line-by-line for top-level
//   `import {...} from '...'`. Its regex is anchored at `^[ \\t]*import\\b`,
//   which ALSO matches indented import-shaped lines INSIDE template
//   literals. If two such phantom imports share a binding name, the
//   emitted CJS shim emits two `const { redirect } = require(...)`
//   declarations → SyntaxError "Identifier 'redirect' has already been
//   declared" at facet pre-compile.
//
//   In-the-wild: `sv@0.15.3/dist/engine-DSL32Woe.mjs` scaffolds SvelteKit
//   project files via template literals containing
//     `import { fail, redirect } from '@sveltejs/kit';`
//     `import { redirect } from '@sveltejs/kit';`
//   inside the template — those are STRING CONTENT, but the line scanner
//   eats them.
//
// Probe asserts:
//   1. synthetic-template-import: a .mjs file with TLA + top-level imports
//      + a template literal containing an `import {...}` line LOADS and
//      runs (its top-level sentinel is logged).
//   2. synthetic-dollar-ident: a .mjs file using esbuild-style $-suffixed
//      identifiers (e.g. `import process$1, { cwd } from 'node:process'`)
//      parses correctly. Pre-fix the \w+ regex truncated at $, missed
//      this import shape, the line landed in body → "Cannot use import
//      statement outside a module" at facet pre-compile.
//   3. wild-sv: `npx --yes sv@latest create ...` runs to completion
//      WITHOUT "Identifier 'redirect' has already been declared". (Probe
//      doesn't assert SK scaffold success in totality — that's the
//      sveltekit-real probe's job. We only check the .mjs-specific
//      pre-compile error is gone.)

import { Terminal, mintSession, sleep, makeAsserter, BASE } from '../_driver.mjs';

const sid = await mintSession();
console.log(`[module-format/dot-mjs-as-esm] sid=${sid} BASE=${BASE}`);

const t = new Terminal(sid);
await t.connect();
await sleep(2_000);
await t.waitForPrompt(60_000);

const A = makeAsserter('module-format/dot-mjs-as-esm');

// ── Check 1: synthetic-template-import ─────────────────────────────
//
// Build a .mjs file with:
//   - top-level ESM `import` (real)
//   - top-level await (TLA)
//   - a template literal containing what LOOKS like an `import {...}`
//     declaration with the same binding name as the real import.
//
// Pre-fix: convertEsmImportsToRequire matches both lines → emits two
//   `const { join } = require('node:path')` → SyntaxError at pre-compile.
// Post-fix: stripCommentsAndStrings masks the template content; only
//   the real import is rewritten → loads cleanly → sentinel printed.

await t.run('rm -rf /home/user/mod-fmt && mkdir -p /home/user/mod-fmt', 5_000);

// The .mjs source is written via shell heredoc to preserve exact bytes
// (especially the embedded backtick template). Single-quoted EOF prevents
// $/`/\\ expansion. We use a binding called "join" because it's a common
// name and any duplicate would crash with "Identifier 'join' has already
// been declared".
const mjsSource = `
import { join } from 'node:path';

// Top-level await forces the two-pass transform path.
const _tla = await Promise.resolve(42);

// Template literal containing import-shaped text. This is what
// sv@0.15.3's engine.mjs does to scaffold SvelteKit project files.
const TEMPLATE = \`
\\tlet x = 1;
\\t\\t\\t\\timport { join } from 'node:path';
\\tconst y = 2;
\\t\\t\\t\\timport { join, dirname } from 'node:path';
\\tconst z = 3;
\`;

console.log('SENTINEL=mjs_template_ok join=' + (typeof join) + ' tla=' + _tla + ' tlen=' + TEMPLATE.length);
`;

await t.run(`cat > /home/user/mod-fmt/probe.mjs << 'NIMBUS_HEREDOC_EOF'\n${mjsSource}\nNIMBUS_HEREDOC_EOF`, 10_000);

const flatResult = await t.run('cd /home/user/mod-fmt && node probe.mjs', 30_000);
A.check(
  'synthetic-template-import: .mjs with TLA + real-import + template-string-import loads + executes',
  /SENTINEL=mjs_template_ok join=function/.test(flatResult.output),
  flatResult.output.slice(-700),
);
A.check(
  'synthetic-template-import: NO "already been declared" error',
  !/already been declared/.test(flatResult.output),
  flatResult.output.slice(-500),
);

// ── Check 2: synthetic-dollar-ident ────────────────────────────────
//
// esbuild's ESM pass-1 renames identifiers that would shadow runtime
// globals. For `import process from 'node:process'`, it emits
// `import process$1, { ... } from 'node:process'` — the `$1` suffix
// disambiguates from the runtime `process` shim. Pre-fix the \\w+ regex
// in convertEsmImportsToRequire stopped at the `$`, so the regex
// missed the line entirely; it ended up in body, and the resulting
// async-IIFE wrap had a top-level `import` statement → SyntaxError
// "import statement outside module".
//
// Synthetic mirror: write a .mjs that uses a $-suffixed identifier.

await t.run('rm -rf /home/user/dollar-id && mkdir -p /home/user/dollar-id', 5_000);
const dollarSource = `
import process$1, { cwd } from 'node:process';
import { join as join$1 } from 'node:path';

const _tla = await Promise.resolve(7);

console.log('SENTINEL=dollar_ok proc=' + (typeof process$1) + ' cwd=' + (typeof cwd) + ' join=' + (typeof join$1) + ' tla=' + _tla);
`;
await t.run(`cat > /home/user/dollar-id/probe.mjs << 'NIMBUS_HEREDOC_EOF'\n${dollarSource}\nNIMBUS_HEREDOC_EOF`, 10_000);
const dollarResult = await t.run('cd /home/user/dollar-id && node probe.mjs', 30_000);
A.check(
  'synthetic-dollar-ident: .mjs with $-suffixed identifier imports loads + executes',
  /SENTINEL=dollar_ok proc=object cwd=function join=function/.test(dollarResult.output),
  dollarResult.output.slice(-600),
);
A.check(
  'synthetic-dollar-ident: NO "import statement outside" error',
  !/import statement outside/i.test(dollarResult.output),
  dollarResult.output.slice(-500),
);

// ── Check 3: wild-sv ────────────────────────────────────────────────
//
// `npx --yes sv@latest create mvp --template minimal --types ts --no-add-ons --no-install`
// triggers loading sv/dist/engine-*.mjs via the npx-cache pipeline.
// Pre-fix this fails with "Identifier 'redirect' has already been declared".
// Post-fix it should at least flip PAST that error. The scaffold itself
// may surface OTHER errors (out of scope for this wave — see
// sveltekit-real probe and audit anti-req).
//
// We DO NOT assert scaffold success — only that the specific .mjs
// pre-compile error is absent from stderr.

await t.run('rm -rf /home/user/sv-probe && mkdir -p /home/user/sv-probe && cd /home/user/sv-probe', 5_000);
const svRun = await t.run(
  'npx --yes sv@latest create mvp --template minimal --types ts --no-add-ons --no-install',
  360_000,
);
const svOut = svRun.output;

A.check(
  'wild-sv: NO "Identifier \'redirect\' has already been declared" in sv invocation',
  !/Identifier 'redirect' has already been declared/.test(svOut),
  svOut.slice(-600),
);
A.check(
  'wild-sv: NO generic "already been declared" syntax error from engine-*.mjs pre-compile',
  !/engine-[^']+\.mjs[\s\S]*?already been declared/.test(svOut),
  svOut.slice(-600),
);

await t.close();
const s = A.summary();
process.exit(s.fail === 0 ? 0 : 1);
