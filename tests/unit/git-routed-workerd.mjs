#!/usr/bin/env bun
// @tier slow — a local workerd probe session with the git runtime installed.
/**
 * git-routed-workerd — with real git installed, the one `git` answers each
 * command where the family policy sends it (packages/worker/src/git/
 * routing.ts), end to end through the shell, on one repository:
 *
 *   - what the built-in git implements (init, add, commit, status, log
 *     --oneline, config) is answered by it: real git's filesystem report
 *     never shows;
 *   - what it lacks runs on real git and does what git does: commit --amend,
 *     stash push and pop, switch -c, restore, rebase, show, blame, log
 *     --graph; and the built-in git reads what real git wrote.
 */

import assert from 'node:assert/strict';
import { localTerminal, startLocalProbe } from './lib/workerd-probe.mjs';

const ID = 'GIT_AUTHOR_NAME=Ada GIT_AUTHOR_EMAIL=ada@example.com GIT_COMMITTER_NAME=Ada GIT_COMMITTER_EMAIL=ada@example.com';
const REAL = '[wasi-fs] git ';
const probe = await startLocalProbe({ runtimes: ['bash', 'git'] });
try {
  const terminal = await localTerminal(probe, { install: ['git'] });
  try {
    /** `git <args>` in repo, with real git's filesystem report on: its output, and whether real git answered. */
    const git = async (args, label = args) => {
      const r = await terminal.run(`cd repo && ${ID} NIMBUS_WASI_FS_STATS=1 git ${args}; echo "status=$?"; cd ~`, 300_000);
      const lines = r.stdout.split('\n');
      const status = Number(/status=(\d+)/.exec(r.stdout)?.[1]);
      assert.equal(status, 0, `${label}: ${r.stdout.slice(-800)}`);
      return { out: lines.filter((line) => !line.includes(REAL) && !/^status=/.test(line)).join('\n'), real: lines.some((line) => line.includes(REAL)) };
    };
    const builtIn = async (args) => {
      const r = await git(args);
      assert.equal(r.real, false, `git ${args}: the built-in git's`);
      return r.out;
    };
    const real = async (args) => {
      const r = await git(args);
      assert.equal(r.real, true, `git ${args}: real git's`);
      return r.out;
    };
    const sh = async (command) => {
      const r = await terminal.run(command, 120_000);
      assert.equal(r.status, 0, `${command}: ${r.stdout.slice(-400)}`);
      return r.stdout;
    };

    await sh("mkdir repo && printf 'one\\ntwo\\n' > repo/a.txt");
    await builtIn('init -q -b main');
    await builtIn('config user.name Ada');
    await builtIn('config user.email ada@example.com');
    await builtIn('add a.txt');
    await builtIn('commit -q -m first');

    // amend: real git; the built-in log reads the commit it made.
    await real('commit -q --amend -m first-amended');
    assert.match(await builtIn('log --oneline -n 1'), /^[0-9a-f]+ first-amended$/m);
    assert.equal(await builtIn('status --porcelain'), '', 'a clean tree, by the built-in status');

    // stash push and pop: the change goes away and comes back.
    await sh("printf 'one\\ntwo\\nthree\\n' > repo/a.txt");
    await real('stash push -q');
    assert.equal(await sh('cat repo/a.txt'), 'one\ntwo\n', 'stashed');
    assert.match(await real('stash list'), /stash@\{0\}/);
    await real('stash pop -q');
    assert.equal(await sh('cat repo/a.txt'), 'one\ntwo\nthree\n', 'popped');

    // restore: the working file is the index's again.
    await real('restore a.txt');
    assert.equal(await sh('cat repo/a.txt'), 'one\ntwo\n', 'restored');

    // switch -c, a commit there, a commit on main, and a rebase of the topic onto it.
    await real('switch -q -c topic');
    assert.equal(await sh('cat repo/.git/HEAD'), 'ref: refs/heads/topic\n');
    await sh("printf 'b\\n' > repo/b.txt");
    await builtIn('add b.txt');
    await builtIn('commit -q -m topic-b');
    await real('switch -q main');
    await sh("printf 'c\\n' > repo/c.txt");
    await builtIn('add c.txt');
    await builtIn('commit -q -m main-c');
    await real('switch -q topic');
    await real('rebase -q main');
    const subjects = (await builtIn('log --oneline')).trim().split('\n').map((line) => line.slice(line.indexOf(' ') + 1));
    assert.deepEqual(subjects, ['topic-b', 'main-c', 'first-amended'], 'the topic replayed onto main');

    // show, blame and log --graph: what real git prints.
    assert.match(await real('show --stat --format=%s HEAD'), /topic-b[\s\S]*b\.txt/);
    assert.match(await real('blame a.txt'), /\) one$/m);
    assert.match(await real('log --graph --oneline'), /^\* [0-9a-f]+ topic-b$/m);
  } finally {
    await terminal.close().catch(() => {});
  }
} finally {
  await probe.stop();
}
console.log('git-routed-workerd: built-in and real git answer their families on one repository');
process.exit(0);
