#!/usr/bin/env bun
// console-facet/new/globalThis-console-equals-console — the canonical
// invariant: `globalThis.console === console` must be true inside the
// facet. Pre-fix:
//   $ node -e 'console.log(globalThis.console === console)'  -> false
//   $ node -e 'console.log(globalThis.console.log === console.log)' -> false
//
// Post-fix both must be true: globalThis.console points at the SAME
// __consoleMod object that the positional `console` param binds to.
//
// Category: R (runtime-behavioral)

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('console-facet/globalThis-console-equals-console');
console.log(`console-facet/globalThis-console-equals-console — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// 1. Object identity — globalThis.console IS console.
{
  const { output } = await t.run(
    `node -e 'console.log("OBJEQ=" + (globalThis.console === console))'`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const has = /OBJEQ=true/.test(stripped);
  a.check('globalThis.console === console (identity, not just shape)', has,
    has ? '' : JSON.stringify(stripped.slice(-300)));
}

// 2. Method identity — the .log function bound on the global IS the
//    same function as on the positional param. Belt-and-suspenders for
//    the (rare) case where the global is patched with a wrapper rather
//    than the same object.
{
  const { output } = await t.run(
    `node -e 'console.log("LOGEQ=" + (globalThis.console.log === console.log) + " ERREQ=" + (globalThis.console.error === console.error))'`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const logOk = /LOGEQ=true/.test(stripped);
  const errOk = /ERREQ=true/.test(stripped);
  a.check('globalThis.console.log === console.log', logOk,
    logOk ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('globalThis.console.error === console.error', errOk,
    errOk ? '' : JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
