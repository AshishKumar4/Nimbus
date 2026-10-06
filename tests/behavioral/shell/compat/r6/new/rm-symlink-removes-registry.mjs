#!/usr/bin/env bun
// shell/compat/r6/new/rm-symlink-removes-registry — SHELL-R6-B5.
//
// Pre-fix: `rm l.txt` after `ln -s t.txt l.txt` errored "No such file
// or directory" because mkRm went straight to vfs.exists() which is
// false for registry-only entries. `readlink` still returned the
// target afterwards (stale registry entry).
//
// Post-fix: mkRm checks SymlinkRegistry FIRST; if symlink, deletes
// the registry entry, leaving the target file alone.

import { mintSession, Terminal, makeAsserter, termBody } from '../../../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell/compat/r6/new/rm-symlink-removes-registry');
console.log(`shell/compat/r6/new/rm-symlink-removes-registry — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

// Setup
await t.run('mkdir -p /tmp/r6rm && cd /tmp/r6rm', 5_000);
await t.run('echo data > t.txt', 5_000);
await t.run('ln -s t.txt l.txt', 5_000);

// Probe 1: readlink pre-rm confirms symlink exists.
const r1 = await t.run('readlink l.txt', 5_000);
a.check('pre-rm: readlink l.txt → "t.txt"',
  termBody(r1.output) === 't.txt',
  `body=${JSON.stringify(termBody(r1.output))}`);

// Probe 2: rm l.txt — no error.
const r2 = await t.run('rm l.txt; echo EX=$?', 5_000);
const r2body = termBody(r2.output);
a.check('rm l.txt — exits clean (EX=0)',
  /EX=0/.test(r2body),
  `body=${JSON.stringify(r2body)}`);
a.check('rm l.txt — no "No such file" error',
  !/No such file/.test(r2body),
  `body=${JSON.stringify(r2body)}`);

// Probe 3: readlink post-rm — registry entry gone (exit 1).
// Acceptable: pure EX=1 (no symlink, no real file), or stderr message
// + EX=1. The CRITICAL assertion is "no longer reports t.txt as the
// target" (which would mean the registry entry wasn't deleted).
const r3 = await t.run('readlink l.txt; echo EX=$?', 5_000);
const r3body = termBody(r3.output);
a.check('post-rm: readlink l.txt exits 1 (not a symlink anymore)',
  /EX=1/.test(r3body),
  `body=${JSON.stringify(r3body)}`);
a.check('post-rm: readlink l.txt does NOT report stale "t.txt" target',
  !/^t\.txt$/m.test(r3body),
  `body=${JSON.stringify(r3body)}`);

// Probe 3b: the path itself is gone, not just its symlink-ness.
const r3b = await t.run('ls l.txt 2>&1; echo EX=$?', 5_000);
const r3bbody = termBody(r3b.output);
a.check('post-rm: ls l.txt fails with "No such file"',
  /No such file|cannot access|ENOENT/i.test(r3bbody) && !/EX=0/.test(r3bbody),
  `body=${JSON.stringify(r3bbody)}`);

// Probe 4: target file t.txt UNAFFECTED.
const r4 = await t.run('cat t.txt', 5_000);
a.check('post-rm: cat t.txt → "data" (target preserved)',
  termBody(r4.output) === 'data',
  `body=${JSON.stringify(termBody(r4.output))}`);

// Probe 5: the removed path takes a new symlink (the registry slot is free).
const r5 = await t.run('ln -s t.txt l.txt && readlink l.txt', 5_000);
a.check('ln -s at the removed path → readlink "t.txt"',
  termBody(r5.output) === 't.txt',
  `body=${JSON.stringify(termBody(r5.output))}`);

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
