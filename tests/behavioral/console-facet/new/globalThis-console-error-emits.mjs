#!/usr/bin/env bun
// console-facet/new/globalThis-console-error-emits — the stderr path
// analog of globalThis-console-log-emits. Same root cause; verifies the
// fix covers .error / .warn paths too (not just .log).
//
// Category: R (runtime-behavioral)

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('console-facet/globalThis-console-error-emits');
console.log(`console-facet/globalThis-console-error-emits — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Run `2>&1` so the terminal's stderr lands inline with stdout (the
// black-box terminal driver doesn't split streams; we sanity-check
// merged output for the marker).
//
// As in globalThis-console-log-emits.mjs, we filter by EXACT line
// match — the terminal echoes the command (including the string
// literal arg) before running the process, so substring search
// would falsely match the echo even when the process emitted nothing.

function hasOutputLine(stripped, marker) {
  const lines = stripped.split(/\r?\n/).map((l) => l.trim());
  return lines.some((l) => l === marker);
}

// 1. Bare console.error baseline.
{
  const { output } = await t.run(
    `node -e 'console.error("bare-err-9134")' 2>&1`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const has = hasOutputLine(stripped, 'bare-err-9134');
  a.check('bare console.error emits "bare-err-9134" as its own line (to stderr)', has,
    has ? '' : JSON.stringify(stripped.slice(-300)));
}

// 2. globalThis.console.error.
{
  const { output } = await t.run(
    `node -e 'globalThis.console.error("global-err-9134")' 2>&1`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const has = hasOutputLine(stripped, 'global-err-9134');
  a.check('globalThis.console.error emits "global-err-9134" as its own line', has,
    has ? '' : JSON.stringify(stripped.slice(-300)));
}

// 3. globalThis.console.warn (mapped to .error in the shim).
{
  const { output } = await t.run(
    `node -e 'globalThis.console.warn("global-warn-9134")' 2>&1`,
    30_000,
  );
  const stripped = stripAnsi(output);
  const has = hasOutputLine(stripped, 'global-warn-9134');
  a.check('globalThis.console.warn emits "global-warn-9134" as its own line', has,
    has ? '' : JSON.stringify(stripped.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
