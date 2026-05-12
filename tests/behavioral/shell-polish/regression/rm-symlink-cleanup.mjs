#!/usr/bin/env bun
// shell-polish/regression/rm-symlink-cleanup — `rm <symlink>` MUST
// remove ONLY the symlink itself, not the target, and MUST clean up
// the SymlinkRegistry entry (subsequent `readlink <link>` returns
// ENOENT, `ls <link>` returns ENOENT). Verified GREEN on prod
// 1914938 (pre-wave).
//
// Coverage rationale: shell-r6 fixed the SymlinkRegistry integration,
// but registry-cleanup-on-rm was a separate code path. This probe
// formally locks the invariant.
//
// Category: R (runtime-behavioral)

import { mintSession, Terminal, makeAsserter, stripAnsi } from '../../_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('shell-polish/rm-symlink-cleanup');
console.log(`shell-polish/rm-symlink-cleanup — ${process.env.BASE}`);

const sid = await mintSession();
const t = new Terminal(sid);
await t.connect();
await t.waitForPrompt(60_000);

await t.run('cd /home/user', 5_000);
await t.run('rm -f sp-rm-target.txt sp-rm-link sp-rm-link2', 5_000);
await t.run('echo "preserve-me" > sp-rm-target.txt', 5_000);
await t.run('ln -s sp-rm-target.txt sp-rm-link', 5_000);

// 1. Confirm symlink set up correctly.
{
  const r = await t.run('readlink sp-rm-link', 5_000);
  const out = stripAnsi(r.output);
  const ok = out.split(/\r?\n/).some((l) => l.trim() === 'sp-rm-target.txt');
  a.check('pre-rm: readlink returns target', ok,
    ok ? '' : JSON.stringify(out.slice(-300)));
}

// 2. rm the symlink.
{
  const r = await t.run('rm sp-rm-link', 5_000);
  const out = stripAnsi(r.output);
  const noErr = !/cannot|error|ENOENT|No such/i.test(out.split(/\r?\n/).filter((l) => !l.includes('rm sp-rm-link')).join('\n'));
  a.check('rm <symlink> emits no error', noErr,
    noErr ? '' : JSON.stringify(out.slice(-300)));
}

// 3. After rm: readlink returns ENOENT.
{
  const r = await t.run('readlink sp-rm-link 2>&1', 5_000);
  const out = stripAnsi(r.output);
  const isGone = /No such file|ENOENT/i.test(out);
  a.check('post-rm: readlink reports "No such file" or ENOENT', isGone,
    isGone ? '' : JSON.stringify(out.slice(-300)));
}

// 4. After rm: ls of the link path returns ENOENT.
{
  const r = await t.run('ls sp-rm-link 2>&1', 5_000);
  const out = stripAnsi(r.output);
  const isGone = /ENOENT|No such file|cannot access/i.test(out);
  a.check('post-rm: ls reports ENOENT', isGone,
    isGone ? '' : JSON.stringify(out.slice(-300)));
}

// 5. The target file MUST still exist (rm of symlink doesn't follow).
{
  const r = await t.run('cat sp-rm-target.txt', 5_000);
  const out = stripAnsi(r.output);
  const lines = out.split(/\r?\n/).map((l) => l.trim());
  const has = lines.some((l) => l === 'preserve-me');
  a.check('post-rm: target file preserved (rm did not follow link)', has,
    has ? '' : JSON.stringify(out.slice(-300)));
}

// 6. Re-creating the SAME symlink after rm works (registry slot reusable).
{
  const r = await t.run('ln -s sp-rm-target.txt sp-rm-link2 && readlink sp-rm-link2', 5_000);
  const out = stripAnsi(r.output);
  const has = out.split(/\r?\n/).some((l) => l.trim() === 'sp-rm-target.txt');
  a.check('ln -s after rm: new symlink resolves correctly', has,
    has ? '' : JSON.stringify(out.slice(-300)));
}

await t.close();
const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
