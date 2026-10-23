#!/usr/bin/env bun
// one-shot-peer/boundaries — a one-shot on the session's peer is the session's
// process, under the session's rules, and ends as one (fabric one-shot-peer.ts).
//   1. Identity: it reads only what its caller may (a file of the user's that
//      alice may not read, alice's run refused it on either host); what it
//      writes is its caller's; its environment reaches it, and the peer stores
//      none of it.
//   2. Kill: Ctrl-C ends a sleeping run on the peer as a killed process (130),
//      as in the session; the time from Ctrl-C to the prompt on each host is
//      recorded. (A computing run is not interrupted promptly on either host:
//      ticket-python-kill-latency.md.)
//   3. Its host lost: a peer reset mid-run ends the run at once (not when the
//      run would have ended), with an error naming the cause; the run is not
//      run again (what it does on starting, an append, happened once), and the
//      next one-shot runs.
import { makeAsserter, mintSession, deleteSession, Terminal, sleep } from '../_driver.mjs';
import { addAlice } from '../durable/_another-account.mjs';
import { peer, warmFor, warmForWorker, lastWorker, mark, hostsSince, median, holdLive } from './_peer.mjs';
import { CPYTHON_RUNNER } from '../../../packages/core/src/runtime/os-contracts.ts';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('one-shot-peer/boundaries');
// The tag a python one-shot's worker carries, whatever build the session installed.
const PY = CPYTHON_RUNNER;
const SECRET = `env-${crypto.randomUUID()}`;
const out = (record) => console.log(JSON.stringify(record));

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);
const other = new Terminal(sid, { terminal: 'other' });
const run = async (line, timeoutMs = 120_000) => {
  const r = await t.run(line, timeoutMs);
  return { ...r, text: r.output };
};
/** `line` run on `host`: the peer forgotten for the session, waited warm for the peer; where it ran, from the session's record. */
async function on(host, line) {
  if (host === 'session') await peer(sid, 'forget');
  else await warmFor(sid, PY);
  const marked = await mark(sid);
  const r = await run(line);
  return { ...r, ranOn: await hostsSince(sid, marked) };
}
const ran = (r, host) => r.ranOn.length > 0 && r.ranOn.every((h) => h === host);
/** What a run printed, a line each, without the command's own echo. */
const lines = (r) => (r.text ?? r.output).split('\n').slice(1).map((line) => line.trim());

try {
  await t.connect();
  await t.waitForPrompt(60_000);
  // A second terminal attached: the session's thread is wanted, so a one-shot may go to the peer.
  await other.connect();
  await other.waitForPrompt(60_000);
  holdLive(other);
  for (const line of ['nimbus install python', 'echo private > /home/user/private.txt && chmod 600 /home/user/private.txt',
    'sudo mkdir -p /srv/shared && sudo chmod 1777 /srv/shared']) {
    const r = await run(line, 600_000);
    if (r.exitCode !== 0) throw new Error(`setup failed: ${line}: ${r.output.slice(-300)}`);
  }
  const alice = await addAlice(run);
  if (!alice.exists) throw new Error(`alice was not added: ${alice.text.slice(-300)}`);
  await run('python3 -c "print(1)"');

  // ── 1. Identity ───────────────────────────────────────────────────────────
  const READ = `sudo -u alice python3 -c "print(open('/home/user/private.txt').read())"`;
  for (const host of ['session', 'peer']) {
    const refused = await on(host, READ);
    a.check(`${host}: alice's run may not read the user's private file`, ran(refused, host) && refused.exitCode !== 0 && /PermissionError/.test(refused.text) && !lines(refused).includes('private'),
      JSON.stringify({ ranOn: refused.ranOn, exit: refused.exitCode, text: refused.text.slice(-300) }));
    const own = await on(host, `python3 -c "print(open('/home/user/private.txt').read().strip())"`);
    a.check(`${host}: the user's own run may`, ran(own, host) && own.exitCode === 0 && lines(own).includes('private'), JSON.stringify({ ranOn: own.ranOn, text: own.text.slice(-300) }));
    const wrote = await on(host, `sudo -u alice python3 -c "open('/srv/shared/by-alice-${host}', 'w').write('x')" && stat -c %u /srv/shared/by-alice-${host}`);
    a.check(`${host}: what alice's run writes is alice's`, ran(wrote, host) && lines(wrote).includes('1001'), JSON.stringify({ ranOn: wrote.ranOn, text: wrote.text.slice(-200) }));
  }
  const env = await on('peer', `SECRET_ENV=${SECRET} python3 -c "import os; print(os.environ['SECRET_ENV'])"`);
  a.check('its environment reaches it on the peer', ran(env, 'peer') && lines(env).includes(SECRET), JSON.stringify({ ranOn: env.ranOn, text: env.text.slice(-200) }));
  const stored = await peer(sid, 'stored', SECRET);
  a.check('and the peer stores none of it', stored.stored === false, JSON.stringify(stored));

  // ── 2. Kill ───────────────────────────────────────────────────────────────
  const KILLED = { sleeping: 'python3 -c "import time; time.sleep(60)"' };
  /**
   * The next run placed on `host`. A killed run's worker is never used
   * again, so the next run takes another, which the peer is not warm for:
   * a short run takes it, gives it back and warms the peer for it.
   */
  const placeNext = async (host) => {
    if (host === 'session') return peer(sid, 'forget');
    await run('python3 -c "pass"');
    await warmForWorker(sid, await lastWorker(sid));
  };
  const kills = [];
  for (let i = 1; i <= 3; i++) {
    for (const [what, line] of Object.entries(KILLED)) {
      for (const host of i % 2 ? ['session', 'peer'] : ['peer', 'session']) {
        await placeNext(host);
        const marked = await mark(sid);
        t.reset();
        t.cmd(line);
        const submission = t.submission;
        await sleep(3000);
        const at = Date.now();
        t.send('\x03');
        await t.waitFor(() => submission.end !== null, 60_000, `${what} run's end after Ctrl-C`);
        const ms = Date.now() - at;
        const ranOn = await hostsSince(sid, marked);
        kills.push({ what, host, ms, exit: submission.exitCode, ranOn });
        out({ kill: what, round: i, host, ms, exit: submission.exitCode, ranOn });
      }
    }
  }
  for (const what of Object.keys(KILLED)) {
    const of = (host) => kills.filter((k) => k.what === what && k.host === host);
    a.check(`Ctrl-C ends a ${what} run on the peer as a killed process, as in the session (prompt after ${median(of('peer').map((k) => k.ms))} ms on the peer, ${median(of('session').map((k) => k.ms))} ms in the session)`,
      [...of('peer').map((k) => ran(k, 'peer')), ...of('session').map((k) => ran(k, 'session'))].every(Boolean) && kills.filter((k) => k.what === what).every((k) => k.exit === 130),
      JSON.stringify(kills.filter((k) => k.what === what)));
  }

  // ── 3. Its host lost ──────────────────────────────────────────────────────
  await placeNext('peer');
  const marked = await mark(sid);
  await run('rm -f /home/user/started.log');
  t.reset();
  t.cmd('python3 -c "open(\'/home/user/started.log\', \'a\').write(\'started\\n\'); import time; time.sleep(30); print(\'SLEPT-\' + \'THROUGH\')"');
  const submission = t.submission;
  // The reset waits for the run to have started: its append is in the session, read from a second terminal.
  const t2 = new Terminal(sid, { terminal: 'observer' });
  await t2.connect();
  await t2.waitForPrompt(60_000);
  for (const until = Date.now() + 30_000; ;) {
    if (lines(await t2.run('cat /home/user/started.log 2>/dev/null', 30_000)).includes('started')) break;
    if (Date.now() > until) throw new Error('the run never started');
    await sleep(200);
  }
  await t2.close();
  const at = Date.now();
  const reset = await peer(sid, 'reset');
  await t.waitFor(() => submission.end !== null, 60_000, 'the run\'s end after its host was lost');
  const endedMs = Date.now() - at;
  const text = t.stream.slice(submission.start, submission.end);
  out({ lost: true, endedMs, exit: submission.exitCode, reset, text: text.slice(-400) });
  a.check(`a run whose peer is lost ends at once (${endedMs} ms after the reset, against 27 s more of its sleep), naming the cause`,
    endedMs < 27_000 && submission.exitCode !== 0 && /one-shot host was lost/.test(text), JSON.stringify({ endedMs, exit: submission.exitCode, text: text.slice(-400) }));
  const lostOn = await hostsSince(sid, marked);
  a.check('it ran on the peer', lostOn.length > 0 && lostOn.every((h) => h === 'peer'), JSON.stringify(lostOn));
  await sleep(Math.max(0, 30_000 - (Date.now() - at)));
  const next = await run('python3 -c "print(2)"');
  const started = lines(await run('cat /home/user/started.log'));
  a.check('it is not run again (it started once), and the next one-shot runs',
    next.exitCode === 0 && lines(next).includes('2') && started.filter((line) => line === 'started').length === 1 && !t.stream.slice(submission.start).includes('SLEPT-THROUGH'),
    JSON.stringify({ exit: next.exitCode, text: next.text.slice(-200), started }));
} catch (error) {
  a.check('the probe ran to its end', false, String(error?.stack ?? error).slice(0, 2000));
} finally {
  await other.close().catch(() => {});
  await t.close().catch(() => {});
  await deleteSession(sid).catch(() => {});
}
const { fail } = a.summary();
process.exit(fail > 0 ? 1 : 0);
