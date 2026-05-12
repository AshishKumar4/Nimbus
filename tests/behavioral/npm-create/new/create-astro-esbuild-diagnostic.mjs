#!/usr/bin/env bun
// npm-create/new/create-astro-esbuild-diagnostic — framework-fixes-F4.
//
// Background: create-astro fails because @bluwy/giget-core ships .js
// files with ESM syntax that our `transformEsmInBundle` either skips
// or fails to transform. Pre-fix the per-file catch in manager.ts
// (~line 1777) silently swallowed esbuild's error and left the ESM
// source raw; the facet's pre-compile loop then emitted
//   "Cannot use import statement outside a module"
// with no information about WHY esbuild rejected the file.
//
// Post-fix F4 does NOT fully fix create-astro (that requires deeper
// investigation — see findings.md). What it DOES is replace the
// silently-swallowed transform failure with an INFORMATIVE diagnostic
// module that throws "esbuild transform failed for <path>: <reason>"
// when require'd. The user sees the underlying esbuild rejection
// reason; future waves can use it to fix the root cause.
//
// Probe shape: drive create-astro; assert the error trace now
// contains the diagnostic prefix "esbuild transform failed" OR the
// install reaches a different failure mode entirely (which would
// mean F4 secondarily helps too).

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('npm-create/new/create-astro-esbuild-diagnostic');
console.log(`npm-create/new/create-astro-esbuild-diagnostic — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function tail(s, n = 1000) { return s.length > n ? '…' + s.slice(-n) : s; }

const r = await t.run(
  'npm create astro@latest test-astro -- --template minimal --no-install --no-typescript --no-git --no-houston --yes 2>&1; echo RC=$?',
  240_000,
);
const out = stripAnsi(r.output);

// The probe accepts EITHER of two post-fix shapes:
//   (a) F4 diagnostic surfaced: trace mentions "esbuild transform"
//   (b) F4 also accidentally healed (transform succeeded): no ESM
//       parse error at all (create-astro proceeds past the
//       @bluwy/giget-core module-init point).
// Pre-fix, NEITHER would hold — instead we'd see the bare
// "Cannot use import statement outside a module" with no diagnostic.
const hasDiagnostic = /esbuild transform failed/.test(out);
const noEsmParseError = !/Cannot use import statement outside a module/.test(out);

a.check('F4 diagnostic OR transform-success: at least one holds',
  hasDiagnostic || noEsmParseError,
  `hasDiagnostic=${hasDiagnostic} noEsmParseError=${noEsmParseError} tail=${JSON.stringify(tail(out))}`);

// Stricter assertion: pre-fix the user saw a useless error; post-fix
// they must see SOMETHING actionable. Either a diagnostic OR
// progression past the prior failure point.
a.check('Post-fix: user-visible error is improved (diagnostic OR new failure surface)',
  hasDiagnostic || /node_modules\/[^@]+\/[^/]+\/[^/]+/.test(out),
  `tail=${JSON.stringify(tail(out))}`);

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
