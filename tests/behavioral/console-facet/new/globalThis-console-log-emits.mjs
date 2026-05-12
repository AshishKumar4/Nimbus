#!/usr/bin/env bun
// console-facet/new/globalThis-console-log-emits — user code that calls
// `globalThis.console.log(...)` MUST emit to stdout. Pre-fix the facet
// only overrode the positional `console` function param at __compiledFn
// — `globalThis.console` remained workerd's native console which writes
// to the worker log, not the supervisor stdout stream, so user output
// was silently lost.
//
// Category: R (runtime-behavioral)
//
// Verbatim pre-fix repro on prod 9ae84cfa:
//   $ node -e 'console.log("bare-A")'          -> "bare-A"
//   $ node -e 'globalThis.console.log("g-B")'  -> (silent — no output)
//
// See /workspace/.seal-internal/2026-05-12-console-facet/repro.mjs.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('console-facet/globalThis-console-log-emits');
console.log(`console-facet/globalThis-console-log-emits — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Important: the terminal echoes the command itself (including the
// string-literal arg) BEFORE running the process, so a naive
// `stripped.includes("global-marker-7421")` falsely matches the echo
// even when the process emitted nothing. We split into lines and
// require an EXACT-line match (the actual print output appears as
// its own line, the echo appears as part of the longer command line).

function hasOutputLine(stripped, marker) {
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  return lines.some((l) => l === marker);
}

// 1. Bare console.log baseline — must work (regression-class check
//    that we didn't break the existing happy path while wiring the
//    new path).
{
  const { output } = await t.run(`node -e 'console.log("bare-marker-7421")'`, 30_000);
  const stripped = stripAnsi(output);
  const has = hasOutputLine(stripped, 'bare-marker-7421');
  a.check('bare console.log emits "bare-marker-7421" as its own output line', has,
    has ? '' : JSON.stringify(stripped.slice(-300)));
}

// 2. globalThis.console.log — the actual bug. Pre-fix: silent. Post-fix:
//    emits exactly like bare console.log.
{
  const { output } = await t.run(
    `node -e 'globalThis.console.log("global-marker-7421")'`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const has = hasOutputLine(stripped, 'global-marker-7421');
  a.check('globalThis.console.log emits "global-marker-7421" as its own output line', has,
    has ? '' : JSON.stringify(stripped.slice(-300)));
}

// 3. Both reachable from a stored reference. Pre-fix:
//      const c = globalThis.console; c.log("x")  -> silent
//    Post-fix: emits.
{
  const { output } = await t.run(
    `node -e 'const c = globalThis.console; c.log("alias-marker-7421")'`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const has = hasOutputLine(stripped, 'alias-marker-7421');
  a.check('aliased globalThis.console.log emits "alias-marker-7421"', has,
    has ? '' : JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
