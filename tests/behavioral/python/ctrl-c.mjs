#!/usr/bin/env bun
// python/ctrl-c — Ctrl-C ends a python run as it ends CPython at a terminal:
// a KeyboardInterrupt and exit 130 (128 + SIGINT), whether the run computes,
// recurses or sleeps, and a handler that catches it runs. A one-shot
// (`python3 -c`) in the session and on its warm peer (a second terminal held
// live wants the session's thread), each run checked to have run where it was
// placed; and a script (`python3 file.py`), which runs as a resident process.
//
// Red before: a computing run went on after Ctrl-C until it ended by itself
// (27-59 s for a 20 s loop), and a sleeping one ended 7.5-9.0 s after it
// (ticket-python-kill-latency.md); a script was killed, with no
// KeyboardInterrupt, and said "python process boot failed"
// (ticket-python-script-ctrl-c.md).
import { makeAsserter, mintSession, deleteSession, Terminal, stripAnsi } from '../_driver.mjs';
import { SPECS } from '../../../packages/worker/scripts/runtime-specs.mjs';
import { peer, warmFor, mark, hostsSince, holdLive } from '../one-shot-peer/_peer.mjs';
import { CPYTHON_RUNNER } from '../../../packages/core/src/runtime/os-contracts.ts';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('python/ctrl-c');

// The build this tree describes.
const BUILD = Object.keys(SPECS).find((key) => key.startsWith('cpython/')).slice('cpython/'.length);
// Ctrl-C to the prompt took 370-1812 ms over 32 computing runs on both hosts
// at check intervals 1e3 to 1e6, 370-781 ms at this image's 1e4 (verdict
// 20261022T235009-25265f1e507e): twice the worst, half of what a sleeping run
// took before.
const BOUND_MS = 2 * 1812;
// Each run ends by itself after about two minutes (3e8 loop turns, fib(38)'s
// 1.3e8 calls, at the 0.4-1 µs a turn or a call cost in the session's
// one-shots): a run Ctrl-C did not end frees the session for the next case.
const STUCK_MS = 300_000;
const STARTED = "print('STAR' + 'TED', flush=True)";
const CASES = {
  computing: { code: `${STARTED}\nfor _ in range(300_000_000): pass`, exit: 130, last: 'KeyboardInterrupt' },
  recursion: { code: `def f(n): return n if n < 2 else f(n-1)+f(n-2)\n${STARTED}\nf(38)`, exit: 130, last: 'KeyboardInterrupt' },
  sleeping: { code: `import time\n${STARTED}\ntime.sleep(120)`, exit: 130, last: 'KeyboardInterrupt' },
  handled: { code: `try:\n    ${STARTED}\n    for _ in range(300_000_000): pass\nexcept KeyboardInterrupt:\n    print('BYE')`, exit: 0, last: 'BYE' },
  // It catches the first and computes on: the second ends it, as a terminal's second Ctrl-C does.
  twice: { code: `try:\n    ${STARTED}\n    for _ in range(300_000_000): pass\nexcept KeyboardInterrupt:\n    print('CAUGHT', flush=True)\nfor _ in range(300_000_000): pass`, exit: 130, last: 'KeyboardInterrupt', again: 'CAUGHT' },
};
// A script that registered a server and was interrupted before it was done is no server.
const SCRIPT_CASES = {
  ...CASES,
  serving: {
    code: `import http.server, time\nserver = http.server.HTTPServer(('127.0.0.1', 8761), http.server.BaseHTTPRequestHandler)\nserver.serve_forever()\n${STARTED}\ntime.sleep(120)`,
    exit: 130, last: 'KeyboardInterrupt', noServer: true,
  },
};
// A one-shot, or a script: `python3 <file>` runs as a resident process (cpython-runner.ts shouldRunAsResidentProcess).
const command = (host, name) => (host === 'script' ? `python3 ctrl-c-${name}.py` : `python3 -c "exec(open('ctrl-c-${name}.py').read())"`);
const lines = (text) => stripAnsi(text).split('\n').map((line) => line.trim()).filter(Boolean);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
const t2 = new Terminal(sid, { terminal: 'observer' });
try {
  await t.connect();
  await t.waitForPrompt(60_000);
  await t2.connect();
  await t2.waitForPrompt(60_000);
  const releaseT2 = holdLive(t2);
  const install = stripAnsi((await t.run(`nimbus install cpython@${BUILD}`, 600_000)).output);
  a.check(`cpython ${BUILD} installs`, /installed at|already installed/.test(install), JSON.stringify(install.slice(-600)));
  for (const [name, { code }] of Object.entries(SCRIPT_CASES)) await t.writeFile(`ctrl-c-${name}.py`, `${code}\n`);
  run: for (const host of ['session', 'peer', 'script']) {
    for (const [name, expected] of Object.entries(host === 'script' ? SCRIPT_CASES : CASES)) {
      if (host === 'session') await peer(sid, 'forget');
      if (host === 'peer') await warmFor(sid, CPYTHON_RUNNER);
      const marked = await mark(sid);
      t.reset();
      t.cmd(command(host, name));
      const submission = t.submission;
      await t.waitFor((view) => lines(view).includes('STARTED'), 120_000, `${name} to start`);
      if (expected.again !== undefined) {
        t.send('\x03');
        await t.waitFor((view) => lines(view).includes(expected.again), BOUND_MS, `${name} to catch the first`);
      }
      const at = Date.now();
      t.send('\x03');
      let seen = '';
      const ended = await t.waitFor((view) => { seen = view; return submission.end !== null; }, STUCK_MS, `${name}'s end after Ctrl-C`).then(() => true, () => false);
      const ms = ended ? Date.now() - at : null;
      const ranOn = await hostsSince(sid, marked);
      const said = lines(seen).filter((line) => !line.endsWith('$'));
      console.log(JSON.stringify({ host, case: name, ms, exit: submission.exitCode, ranOn, tail: said.slice(-3) }));
      if (host !== 'script') a.check(`${host} ${name}: ran where it was placed`, ranOn.length > 0 && ranOn.every((h) => h === host), JSON.stringify(ranOn));
      a.check(`${host} ${name}: ends within ${BOUND_MS} ms of Ctrl-C`, ms !== null && ms <= BOUND_MS, `ended after ${ms === null ? `more than ${STUCK_MS}` : ms} ms`);
      a.check(`${host} ${name}: exit ${expected.exit}, last saying ${expected.last}`,
        submission.exitCode === expected.exit && said.some((line) => line.endsWith(expected.last)), JSON.stringify({ exit: submission.exitCode, tail: said.slice(-4) }));
      if (expected.noServer) {
        // Ended, it no longer runs: a server would run on in the background. ps lists ended processes with their end.
        const ps = stripAnsi((await t.run('ps', 30_000)).output).split('\n').filter((line) => line.includes(`ctrl-c-${name}.py`));
        a.check(`${host} ${name}: not left running as a server`, ps.length > 0 && ps.every((line) => /crashed\(130\)/.test(line)), JSON.stringify(ps));
      }
      // Still running: the terminal is the run's, and nothing after it can run.
      if (!ended) break run;
    }
  }
  releaseT2();
} catch (error) {
  a.check('probe completes', false, String(error?.stack ?? error).slice(0, 2000));
} finally {
  await t.close().catch(() => {});
  await t2.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
