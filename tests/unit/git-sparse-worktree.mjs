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
//   - What is there as git looks: behind a link to a directory, a file
//     outside the cone is there, though the first one below the link is
//     missing; core.sparseCheckout as a bare key is true, and with an
//     explicit empty value false.

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMirror, sh } from './lib/git-mirror.mjs';

const { scratch, Pair, counts } = createMirror('sparse-worktree');

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
    const q = new Pair('dir-to-file', seed('dir-to-file'));
    await q.run(['checkout', 'other']);
    q.same('a directory outside the cone become a file');
    const p = new Pair('added', seed('added'));
    p.write('b/new.txt', 'mine\n');
    p.write('b/d/u', 'untracked\n');
    await p.run(['checkout', 'other']);
    p.same('a switch adding files outside the cone over untracked ones');
    console.log('  ok  what a switch adds outside the cone: skip-worktree, the worktree there untouched');
  }

  {
    // reset keeps skip-worktree bits: add -A then stages nothing outside the cone.
    const p = new Pair('reset', seed('reset'));
    await p.run(['reset', '-q', 'other']);
    p.same('reset (mixed) to other');
    await p.run(['add', '-A']);
    p.same('add -A after the reset');
    await p.run(['reset', '-q', 'main', '--', 'b']);
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
    // "/*" alone is the full cone.
    const p = new Pair('full', seed('full'));
    p.write('.git/info/sparse-checkout', '/*\n');
    await p.run(['checkout', 'main']);
    p.same('a switch under the full cone');
    console.log('  ok  the full cone: every path');
  }

  {
    // core.ignoreCase folds the cone's names.
    const folded = seed('fold');
    sh(folded, ['config', 'core.ignorecase', 'true']);
    const q = new Pair('fold', folded);
    q.write('.git/info/sparse-checkout', '/*\n!/*/\n/B/\n');
    await q.run(['checkout', 'main']);
    q.same('a switch under core.ignoreCase');
    console.log('  ok  core.ignoreCase: the cone compared as git compares it');
  }

  {
    // out/ outside the cone, made a link to a directory holding b/y but not a/: out/a/x is
    // missing (path_found remembers out/a/, not out/), and out/b/y is there behind the link.
    const disk = join(scratch, 'linked');
    mkdirSync(disk);
    sh(disk, ['init', '-q', '-b', 'main']);
    for (const [path, text] of [['a/z.txt', 'z\n'], ['out/a/x', 'x\n'], ['out/b/y', 'y\n']]) {
      mkdirSync(join(disk, path, '..'), { recursive: true });
      writeFileSync(join(disk, path), text);
    }
    sh(disk, ['add', '-A'], ['commit', '-q', '-m', 'one'], ['sparse-checkout', 'set', 'a']);
    mkdirSync(join(disk, 'elsewhere/b'), { recursive: true });
    writeFileSync(join(disk, 'elsewhere/b/y'), 'changed\n');
    symlinkSync('elsewhere', join(disk, 'out'));
    const p = new Pair('linked', disk);
    await p.run(['status', '--porcelain', '-uno'], { stdout: true });
    console.log('  ok  behind a link to a directory: a file outside the cone is there, its missing sibling first');
  }

  for (const [name, line] of [['bare', 'sparseCheckout'], ['empty', 'sparseCheckout =']]) {
    // config.worktree's core.sparseCheckout: a bare key is true, an explicit empty value false.
    const disk = seed('config-' + name);
    writeFileSync(join(disk, '.git/config.worktree'), `[core]\n\t${line}\n\tsparseCheckoutCone = true\n`);
    const p = new Pair('config-' + name, disk);
    p.write('b/x.txt', 'changed\n');
    await p.run(['status', '--porcelain'], { stdout: true });
    console.log(`  ok  core.sparseCheckout as ${name === 'bare' ? 'a bare key: true' : 'an explicit empty value: false'}, as git reads it`);
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
console.log(`git-sparse-worktree: ok (${counts.checks} checks)`);
