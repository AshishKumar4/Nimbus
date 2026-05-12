#!/usr/bin/env bun
// shell-r6/new/concurrent-bg-output — SHELL-R6-B3 (partial fix).
//
// Pre-fix: `echo X & wait` → "wait: command not found"; background-job
// output raced past the prompt.
// Post-fix: `wait` is a real builtin. `cmd & wait` is the supported
// path for collecting background output.
//
// LAYER NOTE: the deeper "naked `cmd &` racing past the prompt" issue
// is a lifo-sh architectural limit not fixed in R6 (would require
// changing the line-editor's printPrompt flow). Documented here.
// Users have a reliable path via `cmd & wait`.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-r6/new/concurrent-bg-output');
console.log(`shell-r6/new/concurrent-bg-output — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

function body(raw) {
  const ansi = stripAnsi(raw);
  const lines = ansi.split(/\r?\n/);
  if (lines.length && /\$\s*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length && /\$\s/.test(lines[0])) lines.shift();
  return lines.join('\n');
}

// Probe 1: `wait` builtin exists.
const r1 = await t.run('wait', 5_000);
const r1body = body(r1.output);
a.check('wait (no jobs) — no "command not found"',
  !/command not found/.test(r1body) && !/wait:/.test(r1body),
  `body=${JSON.stringify(r1body)}`);

// Probe 2: cmd & wait — background output appears before next prompt.
const r2 = await t.run('echo BGMARKER & wait', 5_000);
const r2body = body(r2.output);
a.check('echo BG & wait — BGMARKER present',
  /BGMARKER/.test(r2body),
  `body=${JSON.stringify(r2body)}`);
a.check('echo BG & wait — no "wait: command not found"',
  !/wait: command not found/.test(r2body),
  `body=${JSON.stringify(r2body)}`);

// Probe 3: multi-job wait.
const r3 = await t.run('echo BG1 & echo BG2 & wait', 8_000);
const r3body = body(r3.output);
a.check('echo BG1 & echo BG2 & wait — both markers present',
  /BG1/.test(r3body) && /BG2/.test(r3body),
  `body=${JSON.stringify(r3body)}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
