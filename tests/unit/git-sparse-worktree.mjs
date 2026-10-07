#!/usr/bin/env bun
// The worktree commands in a cone-mode sparse checkout, against host git
// doing the same in the same repository (built on disk by host git, mirrored
// into a SqliteVFS, .git and all): the exit code, git's own messages, and
// after each step the same worktree and index (`ls-files -s -t`, and the
// skip-worktree bits as written).
//   - A file outside the cone that is there (materialized, or made by hand)
//     is no longer skip-worktree once the index is read: status and diff
//     show it, a checkout that would lose its change refuses, and an
//     unchanged one goes on a checkout like any other.
//   - A checkout applies the cone to every entry: one outside it leaves the
//     worktree (named, and kept, if changed), one inside comes back, a
//     directory a removal empties goes; reset --hard leaves nothing outside.
//   - What the target adds outside the cone, a directory become a file
//     included, is indexed skip-worktree, never written, and what the
//     worktree holds there is left alone.
//   - reset (mixed, and of paths) keeps an entry's skip-worktree bit and
//     gives it to a new entry outside the cone: add -A stages no deletion.
//   - add and commit -a leave what is outside the cone alone, named (exit
//     1) when a pathspec or a new file reaches it, but with --sparse.
//   - checkout -- <paths> never checks out a skip-worktree entry, but with
//     --ignore-skip-worktree-bits.
//   - The cone as git reads it: the full cone "/*", and core.ignoreCase.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com', GIT_COMMITTER_DATE: '1700000000 +0000',
  LC_ALL: 'C',
  GIT_CEILING_DIRECTORIES: tmpdir(),
};

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-sparse-worktree-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const harness = createSqliteVfsTestHarness();
const vfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = vfs.as(CRED_KERNEL);
const user = vfs.as(CRED_SESSION_USER);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const files = new ProcessFiles(vfs);

function realGit(cwd, args) {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
function sh(cwd, ...commands) {
  for (const args of commands) {
    const r = realGit(cwd, args);
    assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }
}

/** Copy a disk tree (its .git included) into the VFS at `to`, modes and all. */
function mirror(from, to) {
  user.mkdir(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = `${to}/${name}`;
    const st = lstatSync(src);
    if (st.isDirectory()) mirror(src, dst);
    else if (st.isSymbolicLink()) user.symlink(readlinkSync(src), dst);
    else {
      user.writeFile(dst, new Uint8Array(readFileSync(src)));
      user.chmod(dst, st.mode & 0o777);
    }
  }
}

/** Copy a VFS tree (its .git included) back to disk, links as links. */
function copyOut(from, to) {
  mkdirSync(to, { recursive: true });
  for (const { name, type } of user.readdir(from)) {
    const src = `${from}/${name}`;
    const dst = join(to, name);
    if (type === 'directory') copyOut(src, dst);
    else if (type === 'symlink') symlinkSync(user.readlink(src), dst);
    else {
      writeFileSync(dst, user.readFile(src));
      chmodSync(dst, user.lstat(src).mode & 0o777);
    }
  }
}

async function nimbusGit(cwd, args) {
  let stdout = '';
  let stderr = '';
  const code = await runGitCommand({
    pid: 1,
    cred: CRED_SESSION_USER,
    args,
    cwd,
    env: { USER: 'a', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com' },
    stdout: { write(s) { stdout += s; }, writeBytes(bytes) { stdout += Buffer.from(bytes).toString('utf8'); } },
    stderr: { write(s) { stderr += s; } },
    vfs: files.view({ pid: 1, cred: CRED_SESSION_USER }),
  }, vfs);
  return { code, stdout, stderr };
}

/** A worktree as a sorted list: each path (but .git), its kind and contents. */
function worktreeOf(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (rel === '' && name === '.git') continue;
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isSymbolicLink()) out.push([path, 'link', readlinkSync(join(dir, path))]);
      else if (st.isDirectory()) { out.push([path, 'dir']); walk(path); }
      else out.push([path, 'file', readFileSync(join(dir, path), 'utf8')]);
    }
  };
  walk('');
  return out;
}

/** What git prints on stderr that this git prints on stdout, or not at all: the branch a checkout is on. */
const branchNotes = (text) => text.split('\n').filter((line) => !/^(Switched to|Already on|HEAD is now at)/.test(line)).join('\n');

let checks = 0;
let copies = 0;

/** One repository, on disk for host git and in the VFS for ours, each step run in both. */
class Pair {
  constructor(name, disk) {
    this.name = name;
    this.disk = disk;
    this.virtual = `/home/user/${name}`;
    mirror(disk, this.virtual);
  }

  /** `args` in both: the same exit code; git's stderr (but what `branchNotes` drops), and stdout, where asked. */
  async run(args, { stderr = true, stdout = false } = {}) {
    const label = `${this.name}: git ${args.join(' ')}`;
    const host = realGit(this.disk, args);
    const ours = await nimbusGit(this.virtual, args);
    assert.equal(ours.code, host.code, `${label}: exit code (ours: ${ours.stderr}; git's: ${host.stderr})`);
    if (stderr) assert.equal(branchNotes(ours.stderr), branchNotes(host.stderr), `${label}: stderr`);
    if (stdout) assert.equal(ours.stdout, host.stdout, `${label}: stdout`);
    checks++;
    return ours;
  }

  /** A file written (or removed, `text` null) in both worktrees. */
  write(path, text) {
    const disk = join(this.disk, path);
    const virtual = `${this.virtual}/${path}`;
    if (text === null) {
      rmSync(disk, { force: true });
      if (user.exists(virtual)) user.unlink(virtual);
      return;
    }
    mkdirSync(join(disk, '..'), { recursive: true });
    writeFileSync(disk, text);
    user.mkdir(virtual.slice(0, virtual.lastIndexOf('/')), { recursive: true });
    user.writeFile(virtual, new TextEncoder().encode(text));
  }

  /** The same worktree and index: entries, stages and skip-worktree bits, as read and as written. */
  same(step) {
    const label = `${this.name}: after ${step}`;
    const ours = join(scratch, `ours-${this.name}-${copies++}`);
    copyOut(this.virtual, ours);
    assert.deepEqual(worktreeOf(ours), worktreeOf(this.disk), `${label}: the worktree`);
    for (const args of [['ls-files', '-s', '-t'], ['-c', 'sparse.expectFilesOutsideOfPatterns=true', 'ls-files', '-t'], ['status', '--porcelain']]) {
      assert.equal(realGit(ours, args).stdout, realGit(this.disk, args).stdout, `${label}: git ${args.join(' ')}`);
    }
    checks++;
  }
}

/**
 * A repository in the cone of `a`: main has files at the top, in a/ and in
 * b/ (b/d a directory); other changes a/x.txt and b/y.txt, deletes b/x.txt,
 * adds b/new.txt and makes b/d a file.
 */
function seed(name, cone = ['a']) {
  const disk = join(scratch, name);
  mkdirSync(disk);
  sh(disk, ['init', '-q', '-b', 'main']);
  const put = (path, text) => { mkdirSync(join(disk, path, '..'), { recursive: true }); writeFileSync(join(disk, path), text); };
  put('top.txt', 'top\n');
  put('a/x.txt', 'ax\n');
  put('b/x.txt', 'bx\n');
  put('b/d/f', 'bd\n');
  put('b/y.txt', 'by\n');
  put('b/keep.txt', 'bk\n');
  sh(disk, ['add', '-A'], ['commit', '-q', '-m', 'one'], ['checkout', '-q', '-b', 'other']);
  rmSync(join(disk, 'b/x.txt'));
  rmSync(join(disk, 'b/d'), { recursive: true });
  put('a/x.txt', 'ax2\n');
  put('b/y.txt', 'by2\n');
  put('b/new.txt', 'bn\n');
  put('b/d', 'blob\n');
  sh(disk, ['add', '-A'], ['commit', '-q', '-m', 'two'], ['checkout', '-q', 'main'], ['sparse-checkout', 'set', ...cone]);
  return disk;
}

try {
  {
    // A skipped file made by hand: shown, protected, and gone with the checkout when unchanged.
    const p = new Pair('present', seed('present'));
    p.write('b/x.txt', 'changed\n');
    await p.run(['status', '--porcelain'], { stdout: true });
    await p.run(['diff'], { stdout: true });
    await p.run(['checkout', 'other']);
    p.same('a refused checkout');
    p.write('b/x.txt', 'bx\n');
    await p.run(['status', '--porcelain'], { stdout: true });
    p.same('status of an unchanged file outside the cone');
    await p.run(['checkout', 'other']);
    p.same('the checkout that deletes it');
    console.log('  ok  a file outside the cone that is there: shown by status and diff, protected by checkout');
  }

  {
    // The cone applied to what the switch leaves alone.
    const p = new Pair('cone', seed('cone'));
    p.write('b/keep.txt', 'bk\n');
    await p.run(['checkout', 'other']);
    p.same('a switch with an unchanged file outside the cone');
    p.write('b/keep.txt', 'changed\n');
    await p.run(['checkout', 'main']);
    p.same('a switch with a changed file outside the cone (left, named)');
    p.write('b/y.txt', 'by\n');
    await p.run(['reset', '-q', '--hard']);
    p.same('reset --hard');
    p.write('b/keep.txt', 'changed again\n');
    await p.run(['reset', '-q', '--hard', 'other']);
    p.same('reset --hard to other');
    console.log('  ok  the cone applied to every entry by checkout and reset --hard: outside goes (named if changed)');
  }

  {
    // What the target adds outside the cone, untracked files in its way: indexed skip-worktree, left alone.
    const p = new Pair('added', seed('added'));
    p.write('b/new.txt', 'mine\n');
    p.write('b/d/u', 'untracked\n');
    await p.run(['checkout', 'other']);
    p.same('a switch adding files outside the cone over untracked ones');
    const q = new Pair('dir-to-file', seed('dir-to-file'));
    await q.run(['checkout', 'other']);
    q.same('a directory outside the cone become a file');
    console.log('  ok  what a switch adds outside the cone: skip-worktree, the worktree there untouched');
  }

  {
    // reset keeps skip-worktree bits: add -A then stages nothing outside the cone.
    const p = new Pair('reset', seed('reset'));
    await p.run(['checkout', 'other']);
    await p.run(['reset', '-q', 'main']);
    p.same('reset (mixed) to main');
    await p.run(['add', '-A']);
    p.same('add -A after the reset');
    await p.run(['reset', '-q', 'other', '--', 'b']);
    p.same('reset of paths outside the cone');
    await p.run(['commit', '-q', '-a', '-m', 'all'], { stderr: false });
    p.same('commit -a after the reset of paths');
    console.log('  ok  reset (mixed and of paths): skip-worktree bits kept and given; add -A and commit -a stage no deletion');
  }

  {
    // add leaves what is outside the cone alone, and names it.
    const p = new Pair('add', seed('add'));
    p.write('b/keep.txt', 'changed\n');
    p.write('b/u.txt', 'untracked\n');
    p.write('n.txt', 'new\n');
    p.write('a/x.txt', 'ax3\n');
    await p.run(['add', '-A']);
    p.same('add -A');
    for (const args of [['add', 'b/keep.txt'], ['add', 'b/x.txt'], ['add', 'b'], ['add', '-u', 'b/x.txt'], ['add', '-u', 'b/keep.txt'],
      ['add', 'b/x.txt', 'b/nothing'], ['add', '--sparse', 'b/x.txt']]) {
      await p.run(args);
    }
    await p.run(['add', '-n', 'b/keep.txt', 'a/x.txt'], { stdout: true });
    p.same('adds refused outside the cone');
    await p.run(['add', '--sparse', 'b/u.txt', 'b/keep.txt']);
    p.same('add --sparse');
    p.write('b/keep.txt', 'changed twice\n');
    await p.run(['commit', '-q', '-a', '-m', 'all'], { stderr: false });
    p.same('commit -a with a change outside the cone');
    console.log('  ok  add and commit -a leave what is outside the cone alone, named but with --sparse');
  }

  {
    // checkout -- <paths> does not check out skip-worktree entries.
    const p = new Pair('paths', seed('paths'));
    for (const args of [['checkout', '--', 'b/x.txt'], ['checkout', 'HEAD', '--', 'b/x.txt'], ['checkout', '--', 'b'], ['checkout', '--', '.']]) {
      await p.run(args);
    }
    p.same('checkouts of paths outside the cone');
    await p.run(['checkout', 'other', '--', 'b']);
    p.same('checkout of changed paths outside the cone from a tree');
    await p.run(['checkout', '--ignore-skip-worktree-bits', '--', 'b/keep.txt']);
    p.same('checkout --ignore-skip-worktree-bits');
    console.log('  ok  checkout -- <paths>: skip-worktree entries left, but with --ignore-skip-worktree-bits');
  }

  {
    // The cone as git reads it: "/*" alone is every path; core.ignoreCase folds the cone's names.
    const p = new Pair('full', seed('full'));
    p.write('.git/info/sparse-checkout', '/*\n');
    await p.run(['checkout', 'main']);
    p.same('a switch under the full cone');
    const folded = seed('fold');
    sh(folded, ['config', 'core.ignorecase', 'true']);
    const q = new Pair('fold', folded);
    q.write('.git/info/sparse-checkout', '/*\n!/*/\n/B/\n');
    await q.run(['checkout', 'main']);
    q.same('a switch under core.ignoreCase');
    console.log('  ok  the full cone, and core.ignoreCase: the paths git holds');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`git-sparse-worktree: ok (${checks} checks)`);
