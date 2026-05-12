#!/usr/bin/env bun
// repl-r7/new/python-exit-code-deterministic — REPL-R7-1.
//
// Pre-fix: when a user pastes / sends `python\nexit(N)` as a single
// WS frame, lifo-sh's input handler splits the frame on \r\n and
// pushes lines after the first into shell.pasteQueue. Those lines
// wait for the shell to become idle, but the shell is blocked
// awaiting runPythonRepl. Result: REPL hangs at `>>> ` forever
// because the input never reaches the REPL adapter.
//
// Post-fix: ReplSession drains shell.pasteQueue immediately after
// attaching its replCallback, feeding queued lines into the REPL's
// input stream. The paste case becomes equivalent to typing each
// line individually.
//
// Probe shape: send `python\rexit(N)\r` as ONE WS frame. After REPL
// exits, assert shell $? === N.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('repl-r7/new/python-exit-code-deterministic');
console.log(`repl-r7/new/python-exit-code-deterministic — ${process.env.BASE}`);

async function freshSession() {
  const sid = await mintSession();
  const t = new Terminal(sid);
  await t.connect();
  await t.waitForPrompt(60_000);
  await t.run('nimbus install python', 300_000);
  return t;
}

function tail(s, n = 300) { return s.length > n ? '…' + s.slice(-n) : s; }

async function pasteExit(code) {
  const t = await freshSession();
  t.reset();
  // Send python + exit(N) as ONE WS frame.
  t.send(`python\rexit(${code})\r`);
  let failed = false;
  let lastTail = '';
  try {
    // Wait until shell prompt is back (REPL exited).
    await t.waitFor(
      (b) => /\$\s*$/.test(b.trimEnd().slice(-3)) && />>>/.test(b),
      30_000,
      `shell prompt after exit(${code})`,
    );
  } catch (e) {
    failed = true;
    lastTail = tail(stripAnsi(t.buf));
  }
  let exitVal = null;
  if (!failed) {
    const r = await t.run('echo "EXIT=$?"', 10_000);
    const m = /EXIT=(\d+)/.exec(stripAnsi(r.output));
    exitVal = m ? parseInt(m[1], 10) : null;
  }
  try { await t.close(); } catch {}
  return { failed, exitVal, lastTail };
}

for (const code of [7, 42, 255]) {
  const r = await pasteExit(code);
  a.check(`paste python\\rexit(${code})\\r — REPL exits (no hang)`,
    !r.failed,
    `failed=${r.failed} tail=${JSON.stringify(r.lastTail)}`);
  if (!r.failed) {
    a.check(`paste python\\rexit(${code})\\r — shell $? === ${code}`,
      r.exitVal === code,
      `got=${r.exitVal} expected=${code}`);
  }
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
