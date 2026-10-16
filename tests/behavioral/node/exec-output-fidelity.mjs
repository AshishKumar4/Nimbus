#!/usr/bin/env bun
// node/exec-output-fidelity — a process's stdout must reach its stdout fd,
// whatever the shell made that fd: a file or a pipe, and the terminal while
// the process still runs. A programmatic exec's output is
// sdk/new/live-sdk-exec-output's.
//
// WHY THE ASSERTIONS LOOK LIKE THIS
//   A facet-hosted runtime streams its output straight to the session
//   terminal over the supervisor RPC. So the terminal shows the value even
//   when the redirect that was supposed to capture it wrote nothing —
//   reading the terminal to check a redirect proves only that the mirror
//   fired. Every assertion here therefore reads a BYTE COUNT produced by a
//   separate command (`wc -c`), never the value echoed to the terminal.
//
//   The controls (`echo`, a shell builtin that is not facet-hosted) prove
//   the redirect and the pipe themselves work, so a failure below is about
//   the runtime's output and not about shell plumbing.

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('node/exec-output-fidelity');
console.log(`node/exec-output-fidelity — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

/** Byte count of a path, read by a command that is not the one under test. */
async function byteCount(path) {
  const r = await t.run(`wc -c < ${path}`, 30_000);
  const m = stripAnsi(r.output).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// ── Controls: the shell's own redirect and pipe work ──────────────────
await t.run('echo 42 > /home/user/ctl.txt', 20_000);
a.check('control: shell redirect writes bytes',
  (await byteCount('/home/user/ctl.txt')) === 3,
  `expected 3 bytes ("42\\n"), got ${await byteCount('/home/user/ctl.txt')}`);

{
  const r = await t.run('echo 42 | wc -c', 20_000);
  a.check('control: shell pipe carries bytes',
    /\b3\b/.test(stripAnsi(r.output)),
    `tail: ${JSON.stringify(stripAnsi(r.output).slice(-200))}`);
}

// ── The defect: a facet-hosted runtime's stdout ───────────────────────
await t.run('node -e "console.log(42)" > /home/user/node.txt', 30_000);
{
  const n = await byteCount('/home/user/node.txt');
  a.check('node stdout survives a redirect', n === 3,
    `expected 3 bytes ("42\\n") in the file, got ${n} — the terminal may still have shown 42, which is the supervisor mirror, not the file`);
}

{
  const r = await t.run('node -e "console.log(42)" | wc -c', 30_000);
  const m = stripAnsi(r.output).match(/^\s*(\d+)\s*$/m);
  a.check('node stdout survives a pipe', m !== null && Number(m[1]) === 3,
    `expected the pipe to carry 3 bytes; tail: ${JSON.stringify(stripAnsi(r.output).slice(-200))}`);
}

{
  // A transform in the pipe: if the pipe were empty, `tr` emits nothing and
  // any 42 on screen is the mirror.
  const r = await t.run('node -e "console.log(42)" | tr 4 X > /home/user/tr.txt', 30_000);
  void r;
  const n = await byteCount('/home/user/tr.txt');
  a.check('node stdout survives a pipe into a transform', n === 3,
    `expected 3 bytes ("X2\\n"), got ${n}`);
}

// ── Liveness: bytes must reach the terminal BEFORE the process exits ──
// Without this, the cheapest way to make every assertion above pass is to
// stop streaming and hand the shell one buffer at exit — which turns a
// sixty-second build into a silent hang and loses pipe backpressure. This
// pins the property those fixes must not be bought with.
{
  t.reset();
  // The terminal echoes the command line, so a marker that appears
  // literally in the command matches its own echo and proves nothing. Build
  // both markers at runtime instead: neither string exists in what is typed.
  t.cmd('node -e "const m=(n)=>String.fromCharCode(n,n,n); console.log(m(65)); setTimeout(()=>console.log(m(66)), 4000)"');
  let liveBeforeExit = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const seen = stripAnsi(t.buf);
    if (/AAA/.test(seen)) {
      // BBB has not printed yet, so the process is demonstrably still
      // running: AAA arrived live, not in an exit-time flush.
      liveBeforeExit = !/BBB/.test(seen);
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  a.check('stdout reaches the terminal while the process is still running',
    liveBeforeExit,
    'nothing appeared before exit — output is being buffered until the process ends');
  await t.waitForPrompt(30_000).catch(() => {});
}

await t.close();

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
