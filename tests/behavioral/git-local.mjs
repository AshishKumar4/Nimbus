#!/usr/bin/env bun
// behavioral/git-local — the offline half of `git`: init, status, add,
// commit, in a repository that has no .gitignore.
//
// That last clause is the whole point. cf-git asks its filesystem for
// .gitignore before it stages or reports anything, and a missing file
// comes back as null; whether the ignore matcher tolerates that null is
// decided by which version of `ignore` the Worker bundle links. When it
// linked one that did not, every `git add` and `git status` on a fresh
// repository died with "Cannot read properties of null (reading
// 'pattern')" — and no probe noticed, because the only git coverage was
// `git clone`, which runs in the network facet with its own linkage.
//
// Black-box surfaces only. NO _diag.

import { deleteSession, makeAsserter, mintSession, sleep, Terminal } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('git-local');
console.log(`behavioral/git-local — init/status/add/commit with no .gitignore\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

try {
  await t.connect();
  await sleep(2_000);

  await t.run('mkdir -p /home/user/local-git && cd /home/user/local-git', 30_000);
  const init = await t.run('git init', 60_000);
  a.check('git init reports an initialized repository', /Initialized empty Git repository/.test(init.output), init.output.slice(-200));

  await t.run('echo hello > tracked.txt', 30_000);

  const untracked = await t.run('git status', 60_000);
  a.check('git status lists the untracked file', /\?\?\s+tracked\.txt/.test(untracked.output), untracked.output.slice(-200));

  const add = await t.run('git add tracked.txt', 60_000);
  a.check('git add reports no fatal', !/fatal:/.test(add.output), add.output.slice(-200));

  const staged = await t.run('git status', 60_000);
  a.check('git status reports the file as added', /A\s+tracked\.txt/.test(staged.output), staged.output.slice(-200));

  const commit = await t.run('git commit -m "initial"', 60_000);
  a.check('git commit prints a short sha', /\[[0-9a-f]{7}\] initial/.test(commit.output), commit.output.slice(-200));

  const clean = await t.run('git status', 60_000);
  a.check('git status reports a clean tree after commit', /nothing to commit, working tree clean/.test(clean.output), clean.output.slice(-200));

  // `git add .` walks the status matrix instead of a single pathspec —
  // a separate entry into the same ignore lookup.
  await t.run('echo second > another.txt', 30_000);
  const addAll = await t.run('git add .', 60_000);
  a.check('git add . reports no fatal', !/fatal:/.test(addAll.output), addAll.output.slice(-200));

  const stagedAll = await t.run('git status', 60_000);
  a.check('git status reports the second file as added', /A\s+another\.txt/.test(stagedAll.output), stagedAll.output.slice(-200));
} finally {
  await t.close();
  await deleteSession(sid);
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
