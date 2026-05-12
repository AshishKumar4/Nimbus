#!/usr/bin/env bun
// console-facet/regression/bare-console-log-still-works — the pre-fix
// happy path. After wiring globalThis.console to the supervisor-streaming
// __consoleMod, the BARE `console.log(...)` (which resolves through the
// positional fn param) must continue to emit normally.
//
// Multiple emit shapes covered: console.log, console.error, console.info,
// console.warn, console.debug, util.format-style multi-arg.
//
// Category: R (runtime-behavioral)

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('console-facet/bare-console-log-still-works');
console.log(`console-facet/bare-console-log-still-works — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// EXACT-line matcher — the terminal echoes the command-string before
// running the process, so substring-search would falsely match the
// echo for `console.log("...")`-shaped args. Real process output
// arrives on its own line.
function hasOutputLine(stripped, marker) {
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  return lines.some((l) => l === marker);
}

// 1. console.log — the canonical hot path.
{
  const { output } = await t.run(`node -e 'console.log("regress-log-A")'`, 30_000);
  const has = hasOutputLine(stripAnsi(output), 'regress-log-A');
  a.check('console.log("regress-log-A") emits as its own line', has,
    has ? '' : JSON.stringify(stripAnsi(output).slice(-300)));
}

// 2. console.error (merged with 2>&1).
{
  const { output } = await t.run(
    `node -e 'console.error("regress-err-B")' 2>&1`,
    30_000,
  );
  const has = hasOutputLine(stripAnsi(output), 'regress-err-B');
  a.check('console.error("regress-err-B") emits as its own line', has,
    has ? '' : JSON.stringify(stripAnsi(output).slice(-300)));
}

// 3. console.info/debug map to stdout in our shim.
{
  const { output } = await t.run(
    `node -e 'console.info("regress-info-C"); console.debug("regress-debug-D")'`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const hasInfo = hasOutputLine(stripped, 'regress-info-C');
  const hasDebug = hasOutputLine(stripped, 'regress-debug-D');
  a.check('console.info("regress-info-C") emits as its own line', hasInfo,
    hasInfo ? '' : JSON.stringify(stripped.slice(-300)));
  a.check('console.debug("regress-debug-D") emits as its own line', hasDebug,
    hasDebug ? '' : JSON.stringify(stripped.slice(-300)));
}

// 4. multi-arg util.format-style: console.log("x=%d y=%s", 42, "hi")
//    must produce "x=42 y=hi" on its own line.
{
  const { output } = await t.run(
    `node -e 'console.log("x=%d y=%s", 42, "hi")'`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const has = hasOutputLine(stripped, 'x=42 y=hi');
  a.check('console.log with util.format substitution', has,
    has ? '' : JSON.stringify(stripped.slice(-300)));
}

// 5. process.stdout.write — orthogonal but uses the same SUPERVISOR
//    streaming infra. Must still flow.
{
  const { output } = await t.run(
    `node -e 'process.stdout.write("regress-pwrite-E\\n")'`,
    30_000,
  );
  const has = hasOutputLine(stripAnsi(output), 'regress-pwrite-E');
  a.check('process.stdout.write still emits after globalThis.console patch', has,
    has ? '' : JSON.stringify(stripAnsi(output).slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
