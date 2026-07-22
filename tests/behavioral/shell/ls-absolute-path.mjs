#!/usr/bin/env bun
// shell/ls-absolute-path — `ls <abs-path>` inside bash must list the
// requested path, not the session cwd.
//
// Regression: bash execs the BusyBox `ls` applet, whose wasi-libc has
// cwd '/', so absolute args ('/tmp') and cwd-relative args ('tmp') reach
// path_open IDENTICALLY un-prefixed, and 'ls /' / bare 'ls' both arrive
// as '.'. The exec layer re-anchored every path against the session cwd
// to emulate cwd inheritance, which silently made `ls /` (and every
// `ls /abs`) list the cwd instead. The fix recovers the absolute-vs-
// relative bit from the argv bash passed the applet.
//
// Public contract:
//   - `ls /` lists the root filesystem (bin, usr), NOT ~ contents.
//   - `ls /home/user` lists the home dir by absolute path.
//   - bare `ls` and `cd X; ls` still list the cwd.
//   - a cwd-relative dir arg still resolves against the cwd (inheritance).
//   - `ls /missing` errors instead of silently listing the cwd.

import { deleteSession, makeAsserter, mintSession, stripAnsi, Terminal } from '../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const label = 'shell/ls-absolute-path';
const a = makeAsserter(label);
console.log(`${label} — ${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

const has = (out, word) => stripAnsi(out).replace(/\r/g, '\n').split('\n').map((l) => l.trim()).includes(word);
const tail = (out) => JSON.stringify(stripAnsi(out).slice(-600));

try {
  await t.connect();
  await t.waitForPrompt(60_000);

  // BusyBox coreutils (the `ls` applet bash execs) ship with `bash`.
  await t.run('nimbus install bash', 180_000);

  {
    const { output } = await t.run("bash -c 'ls /'", 60_000);
    a.check('bash: `ls /` lists the ROOT filesystem, not the cwd',
      has(output, 'bin') && has(output, 'usr') && !has(output, 'welcome.md'),
      tail(output));
  }

  {
    const { output } = await t.run("bash -c 'ls /home/user'", 60_000);
    a.check('bash: `ls /home/user` lists home by absolute path',
      has(output, 'welcome.md') && !/No such file/.test(stripAnsi(output)),
      tail(output));
  }

  {
    const { output } = await t.run("bash -c 'cd /home/user && ls'", 60_000);
    a.check('bash: bare `ls` still lists the cwd',
      has(output, 'welcome.md'),
      tail(output));
  }

  // Absolute vs cwd-relative disambiguation: a dir that exists ONLY under
  // the cwd must be reachable relatively AND absent at the root.
  await t.run("bash -c 'mkdir -p /home/user/ptest && echo M > /home/user/ptest/CWDMARK'", 60_000);
  {
    const { output } = await t.run("bash -c 'cd /home/user && ls ptest'", 60_000);
    a.check('bash: cwd-relative dir arg resolves against the cwd (inheritance)',
      has(output, 'CWDMARK'),
      tail(output));
  }
  {
    const { output } = await t.run("bash -c 'ls /ptest'", 60_000);
    a.check('bash: `/ptest` (absolute) does NOT resolve to the cwd dir',
      /No such file/.test(stripAnsi(output)) && !has(output, 'CWDMARK'),
      tail(output));
  }

  {
    const { output } = await t.run("bash -c 'ls /nonexistent-xyz'", 60_000);
    a.check('bash: `ls /missing` errors instead of listing the cwd',
      /No such file|cannot access/i.test(stripAnsi(output)) && !has(output, 'welcome.md'),
      tail(output));
  }
} finally {
  try { await t.close(); } catch {}
  const cleanup = await deleteSession(sid);
  a.check('probe session deleted', cleanup.ok,
    `status=${cleanup.status} body=${JSON.stringify(cleanup.body.slice(0, 500))}`);
}
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
