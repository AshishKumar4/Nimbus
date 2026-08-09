#!/usr/bin/env bun
// behavioral/git-ignore — .gitignore actually excludes files from
// `git status` and `git add`.
//
// The companion to git-local, which covers the repository that has no
// .gitignore at all. This one covers the repository that has one, and
// it exists because "no crash" turned out not to mean "working": cf-git
// reads the file with `fs.read(path, 'utf8')` — the bare-encoding
// spelling of the node fs contract — and the VFS adapter honoured only
// `{ encoding: 'utf8' }`, so it handed back bytes. `ignore().add()`
// accepts only strings and skips anything else without complaining, so
// every rule in every .gitignore was silently a no-op and `git add .`
// staged node_modules.
//
// Negation and nested files are covered too: they are the rules a
// half-working matcher gets wrong first.
//
// Black-box surfaces only. NO _diag.

import { deleteSession, makeAsserter, mintSession, sleep, Terminal } from './_driver.mjs';

if (!process.env.BASE) { console.error('FATAL: BASE env required'); process.exit(2); }
const a = makeAsserter('git-ignore');
console.log(`behavioral/git-ignore — .gitignore excludes what it names\nBASE=${process.env.BASE}`);

const sid = await mintSession();
console.log(`SID: ${sid}`);
const t = new Terminal(sid);

try {
  await t.connect();
  await sleep(2_000);

  await t.run('mkdir -p /home/user/ig/sub /home/user/ig/node_modules/pkg && cd /home/user/ig', 30_000);
  await t.run('git init', 60_000);

  await t.run("echo 'node_modules/' > .gitignore", 30_000);
  await t.run("echo '*.log' >> .gitignore", 30_000);
  await t.run("echo '!keep.log' >> .gitignore", 30_000);
  await t.run("echo 'nested-ignored.txt' > sub/.gitignore", 30_000);

  await t.run("echo 'app' > app.js", 30_000);
  await t.run("echo 'dbg' > debug.log", 30_000);
  await t.run("echo 'keep' > keep.log", 30_000);
  await t.run("echo 'nm' > node_modules/pkg/index.js", 30_000);
  await t.run("echo 'ni' > sub/nested-ignored.txt", 30_000);
  await t.run("echo 'nk' > sub/nested-kept.txt", 30_000);

  const status = await t.run('git status', 60_000);
  a.check('status lists a file no rule covers', /\?\?\s+app\.js/.test(status.output), status.output.slice(-400));
  a.check('status EXCLUDES a file matched by *.log', !/debug\.log/.test(status.output), status.output.slice(-400));
  a.check('status honours the !keep.log negation', /\?\?\s+keep\.log/.test(status.output), status.output.slice(-400));
  a.check('status EXCLUDES everything under an ignored directory', !/node_modules/.test(status.output), status.output.slice(-400));
  a.check('status honours a nested sub/.gitignore', !/nested-ignored\.txt/.test(status.output), status.output.slice(-400));
  a.check('a nested .gitignore does not swallow its siblings', /\?\?\s+sub\/nested-kept\.txt/.test(status.output), status.output.slice(-400));

  await t.run('git add .', 60_000);
  // An explicit pathspec is a second, separate entry into the ignore
  // lookup — `git add .` walks the already-filtered status matrix.
  await t.run('git add debug.log', 60_000);
  await t.run('git add node_modules/pkg/index.js', 60_000);

  const staged = await t.run('git status', 60_000);
  a.check('add . staged the file no rule covers', /A\s+app\.js/.test(staged.output), staged.output.slice(-400));
  a.check('add . staged the negated file', /A\s+keep\.log/.test(staged.output), staged.output.slice(-400));
  a.check('an explicit `git add` does NOT stage an ignored file', !/debug\.log/.test(staged.output), staged.output.slice(-400));
  a.check('an explicit `git add` does NOT stage an ignored directory', !/node_modules/.test(staged.output), staged.output.slice(-400));

  // Ignored means excluded from git, not removed from the workspace.
  const onDisk = await t.run('cat debug.log', 30_000);
  a.check('the ignored file is untouched on disk', /dbg/.test(onDisk.output), JSON.stringify(onDisk.output.slice(-200)));
} finally {
  await t.close();
  await deleteSession(sid);
}

const s = a.summary();
process.exit(s.fail === 0 ? 0 : 1);
