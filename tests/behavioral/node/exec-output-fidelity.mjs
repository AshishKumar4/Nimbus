#!/usr/bin/env bun
// node/exec-output-fidelity — a process's stdout must reach its stdout fd,
// whatever the shell made that fd: a file, a pipe, or the caller of a
// programmatic exec.
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
//
// COVERAGE THIS CLOSES
//   tests/behavioral/sdk/new/live-sdk-remote-smoke.mjs already asserts
//   exec('node -e ...') returns its stdout, but it is listed in
//   _probe-target-skips.mjs because it needs hosted-demo OAuth — so no
//   headless run has ever executed that assertion. This probe runs against
//   any bearer-token target (apps/probe, staging, a throwaway).

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
  t.cmd('node -e "console.log(\'early\'); setTimeout(() => console.log(\'late\'), 4000)"');
  let liveBeforeExit = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const seen = stripAnsi(t.buf);
    if (/early/.test(seen)) {
      // `late` has not printed yet, so the process is demonstrably still
      // running: `early` arrived live, not in an exit-time flush.
      liveBeforeExit = !/late/.test(seen);
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  a.check('stdout reaches the terminal while the process is still running',
    liveBeforeExit,
    'nothing appeared before exit — output is being buffered until the process ends');
  await t.waitForNewPrompt(30_000).catch(() => {});
}

await t.close();

// ── The programmatic path: exec()'s result IS the output ──────────────
// Headless, over the same remote RPC API a ComputeSDK provider uses.
if (process.env.NIMBUS_PROBE_TOKEN) {
  const { Nimbus } = await import('../../../packages/sdk/src/index.ts');
  const box = Nimbus.connect({
    endpoint: process.env.BASE,
    token: process.env.NIMBUS_PROBE_TOKEN,
  }).sandbox(`execout-${Date.now().toString(36)}`);

  try {
    const shell = await box.exec('echo 42');
    a.check('control: programmatic exec returns shell stdout',
      shell.stdout.trim() === '42', `stdout: ${JSON.stringify(shell.stdout)}`);

    const node = await box.exec('node -e "console.log(42)"');
    a.check('programmatic exec returns node stdout',
      node.stdout.trim() === '42',
      `exit ${node.exitCode}, stdout: ${JSON.stringify(node.stdout)}, stderr: ${JSON.stringify(node.stderr.slice(0, 200))}`);

    const code = await box.runCode('console.log(42)');
    a.check('runCode returns its output',
      code.stdout.trim() === '42',
      `exit ${code.exitCode}, stdout: ${JSON.stringify(code.stdout)}`);
  } finally {
    await box.destroy({ reason: 'exec-output-fidelity-cleanup' }).catch(() => {});
  }
} else {
  console.log('  (skipped programmatic checks — NIMBUS_PROBE_TOKEN not set)');
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
