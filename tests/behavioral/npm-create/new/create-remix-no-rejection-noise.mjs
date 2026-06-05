#!/usr/bin/env bun
// npm-create/new/create-remix-no-rejection-noise — framework-fixes-F3.
//
// Pre-fix: create-remix is upstream-deprecated and emits a
// deprecation banner + process.exit(0). Our __processMod.exit shim
// throws __ProcessExit (intentional, to halt user code). For async
// fire-and-forget code paths (e.g. an async main() with no .catch()),
// __ProcessExit bubbles to globalThis 'unhandledrejection' and
// __reportUnhandled emitted:
//   "Unhandled promise rejection: Error: process.exit(0)"
// Combined with the intended deprecation banner, this looked like a
// real failure to users.
//
// Post-fix: __reportUnhandled filters __ProcessExit (both via
// instanceof and via /^process\\.exit\\(/ message-shape match for
// cross-microtask cases that lose prototype chain). Exit code
// semantics unchanged — only the noisy stderr line is suppressed.
//
// Probe shape: drive create-remix; assert the deprecation banner is
// still emitted (user-visible semantic preserved) AND the
// rejection-noise line is absent.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('npm-create/new/create-remix-no-rejection-noise');
console.log(`npm-create/new/create-remix-no-rejection-noise — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function tail(s, n = 800) { return s.length > n ? '…' + s.slice(-n) : s; }

const r = await t.run(
  'npm create remix@latest test-remix -- --template ./packages/templates/blank --no-install --yes 2>&1; echo RC=$?',
  240_000,
);
const out = stripAnsi(r.output);

// Probe 1: deprecation banner still surfaces (we did NOT change
// upstream behavior, just suppressed our noise).
a.check('create-remix deprecation banner still emitted',
  /Remix v2 is now part of React Router/.test(out) ||
    /please use React Router instead/.test(out),
  `tail=${JSON.stringify(tail(out))}`);

// Probe 2: no "Unhandled promise rejection: Error: process.exit" noise.
a.check('No "Unhandled promise rejection: Error: process.exit" noise',
  !/Unhandled promise rejection: Error: process\.exit/.test(out),
  `tail=${JSON.stringify(tail(out))}`);

// Probe 3: no generic "Unhandled" + "process.exit" anywhere paired.
const hasUnhandled = /Unhandled (promise rejection|Rejection)/.test(out);
const hasProcessExit = /process\.exit\(/.test(out);
a.check('No paired Unhandled-rejection + process.exit signature',
  !(hasUnhandled && hasProcessExit),
  `unhandled=${hasUnhandled} processExit=${hasProcessExit} tail=${JSON.stringify(tail(out))}`);

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
