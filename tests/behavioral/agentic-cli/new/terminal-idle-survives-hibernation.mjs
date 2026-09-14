#!/usr/bin/env bun
// agentic-cli/new/terminal-idle-survives-hibernation — a terminal socket that
// sits idle long enough for the session object to hibernate still runs the
// next command.
//
// The runtime evicts a quiet session object from memory while its accepted
// terminal socket stays open. Measured 2026-09-14 on a deployed probe
// Worker: 8 s idle and the next command answered; 10 s idle and it did not.
// The frame that woke the object landed on a fresh instance with no shell
// behind the socket, and the command vanished — no output, no close, no
// error, so a driver waiting on the socket stalled until its own timeout.
// A browser tab never sat still long enough to see it.
//
// The idle here is far past the threshold so a slower eviction cannot make
// the probe pass by accident. An agent driving a project through the
// terminal thinks for longer than this between commands.

import { deleteSession, makeAsserter, mintSession, sleep, stripAnsi, Terminal } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'agentic-cli/new/terminal-idle-survives-hibernation';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const IDLE_MS = Number(process.env.NIMBUS_PROBE_IDLE_MS || 180_000);
const REPORT_EVERY_MS = 30_000;

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
try {
  await t.connect();
  await t.waitForPrompt(60_000);

  const before = await t.run('cd /tmp && echo one', 30_000);
  a.check('a command answers before the idle',
    /\bone\b/.test(stripAnsi(before.output).replace('echo one', '')),
    JSON.stringify(stripAnsi(before.output).slice(-200)));

  // Idle with nothing on the socket. The readiness of the socket itself is
  // recorded along the way: a close here would be a different defect and
  // the driver reports it as one.
  const idleStart = Date.now();
  let nextReport = REPORT_EVERY_MS;
  while (Date.now() - idleStart < IDLE_MS) {
    await sleep(1_000);
    if (t.closed) {
      throw new Error(`terminal socket closed after ${Date.now() - idleStart}ms idle (${t.closeDetail})`);
    }
    if (Date.now() - idleStart >= nextReport) {
      console.log(`  idle ${Math.round((Date.now() - idleStart) / 1000)}s, socket still open`);
      nextReport += REPORT_EVERY_MS;
    }
  }
  a.check(`the socket is still open after ${Math.round(IDLE_MS / 1000)}s idle`, !t.closed, t.closeDetail ?? '');

  const after = await t.run('echo two', 30_000);
  const output = stripAnsi(after.output);
  a.check('the first command after the idle produces its output',
    /\btwo\b/.test(output.replace('echo two', '')),
    JSON.stringify(output.slice(-300)));

  // The shell that answered is the same session: cwd set before the idle
  // survives it (the rebuild reads it back from the session's storage).
  const where = await t.run('pwd', 30_000);
  a.check('the shell keeps the cwd set before the idle',
    /^\/tmp\s*$/m.test(stripAnsi(where.output).replace('pwd', '')),
    JSON.stringify(stripAnsi(where.output).slice(-200)));
} finally {
  await t.close();
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted',
    cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 300))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
