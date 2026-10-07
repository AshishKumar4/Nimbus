#!/usr/bin/env bun
// `git sparse-checkout` (git/sparse-checkout.ts) against host git doing the
// same in the same repository (built on disk by host git, mirrored into a
// SqliteVFS): the exit code, git's messages, and after each step the same
// worktree and index (skip-worktree bits as read and as written), the same
// info/sparse-checkout byte for byte, and the same configuration
// (config and config.worktree, as git lists them).
//   - In a repository that is not sparse: list, add and reapply refused as
//     git refuses them; set turns cone mode on (extensions.worktreeConfig,
//     core.sparseCheckout, core.sparseCheckoutCone) and moves the worktree;
//     list names the cone; add widens it; set run from a subdirectory takes
//     its directories below it.
//   - What set leaves: a changed file outside the cone (named, kept); a
//     directory outside the cone with untracked files in it (named, kept);
//     one with only ignored files and empty directories (removed, with
//     them).
//   - reapply after the file is edited by hand; disable: every file back,
//     sparse checkout off; init: the top's files only.
//   - Refused as git refuses them: a leading slash, a pattern, a '!', a
//     file named as a directory (taken with --skip-checks), an unknown
//     subcommand or option, none at all.
//   - From a subdirectory, an absolute path inside the repository is its
//     directory (with --skip-checks too), and one outside is refused.
//   - Two sets at once: the second sees the first's whole result (one lock
//     from the configuration to the patterns), never one's patterns over
//     the other's worktree.
//   - Not cone mode (--no-cone) and a sparse index are refused, named.

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMirror, realGit, sh } from './lib/git-mirror.mjs';

const { scratch, nimbusGit, Pair, counts } = createMirror('sparse-checkout');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A repository: files at the top, in a/, in b/ (b/d a directory below it), and c/e/f deep. */
function seed(name) {
  const disk = join(scratch, name);
  mkdirSync(disk);
  sh(disk, ['init', '-q', '-b', 'main']);
  for (const [path, text] of [
    ['top.txt', 'top\n'], ['.gitignore', '*.log\n'], ['a/x.txt', 'ax\n'], ['b/y.txt', 'by\n'], ['b/d/f', 'bdf\n'], ['c/e/f/g', 'g\n'],
  ]) {
    mkdirSync(join(disk, path, '..'), { recursive: true });
    writeFileSync(join(disk, path), text);
  }
  sh(disk, ['add', '-A'], ['commit', '-q', '-m', 'one']);
  return disk;
}

/** The same sparse-checkout file and configuration, as git lists them. */
function sameFiles(p, step) {
  const ours = p.copy();
  const read = (dir, file) => { try { return readFileSync(join(dir, '.git', file), 'utf8'); } catch { return null; } };
  assert.equal(read(ours, 'info/sparse-checkout'), read(p.disk, 'info/sparse-checkout'), `${p.name}: after ${step}: info/sparse-checkout`);
  for (const file of ['config', 'config.worktree']) {
    const list = (dir) => (read(dir, file) === null ? null : realGit(dir, ['config', '-f', `.git/${file}`, '--list']).stdout.split('\n').sort().join('\n'));
    assert.equal(list(ours), list(p.disk), `${p.name}: after ${step}: .git/${file}`);
  }
  counts.checks++;
}

try {
  {
    // A repository that is not sparse, made sparse, widened, and listed.
    const p = new Pair('cone', seed('cone'));
    for (const args of [['sparse-checkout', 'list'], ['sparse-checkout', 'add', 'a'], ['sparse-checkout', 'reapply']]) await p.run(args);
    await p.run(['sparse-checkout', 'set', 'a']);
    p.same('set a');
    sameFiles(p, 'set a');
    await p.run(['sparse-checkout', 'list'], { stdout: true });
    await p.run(['sparse-checkout', 'add', 'c/e']);
    p.same('add c/e');
    sameFiles(p, 'add c/e');
    await p.run(['sparse-checkout', 'list'], { stdout: true });
    await p.run(['sparse-checkout', 'set', 'a', 'b']);
    await p.run(['sparse-checkout', 'set', 'd'], { sub: 'b' });
    p.same('set d, from b/');
    sameFiles(p, 'set d, from b/');
    await p.run(['sparse-checkout', 'list'], { stdout: true });
    console.log('  ok  set, add and list from a repository that was not sparse; set from a subdirectory');
  }

  {
    // What set leaves outside the cone.
    const p = new Pair('left', seed('left'));
    await p.run(['sparse-checkout', 'set', 'a', 'b', 'c']);
    p.write('b/y.txt', 'changed\n');
    p.write('b/d/untracked.txt', 'mine\n');
    p.write('c/e/build.log', 'ignored\n');
    await p.run(['sparse-checkout', 'set', 'a']);
    p.same('set a, with a changed file and untracked and ignored files outside it');
    sameFiles(p, 'set a');
    // Nothing but what is ignored, then nothing at all: the directory goes.
    p.write('b/y.txt', 'by\n');
    p.write('b/d/untracked.txt', null);
    p.write('c/e/build.log', null);
    await p.run(['sparse-checkout', 'reapply']);
    p.same('reapply, once nothing untracked is left');
    console.log('  ok  set and reapply: a changed file and a directory with untracked files named and kept; one with only ignored files removed');
  }

  {
    // reapply after an edit by hand; disable; init.
    const p = new Pair('edit', seed('edit'));
    await p.run(['sparse-checkout', 'set', 'a']);
    p.write('.git/info/sparse-checkout', '/*\n!/*/\n/c/\n');
    await p.run(['sparse-checkout', 'reapply']);
    p.same('reapply of a file edited by hand');
    await p.run(['sparse-checkout', 'list'], { stdout: true });
    await p.run(['sparse-checkout', 'disable']);
    p.same('disable');
    sameFiles(p, 'disable');
    await p.run(['sparse-checkout', 'list']);
    const q = new Pair('init', seed('init'));
    await q.run(['sparse-checkout', 'init']);
    q.same('init');
    sameFiles(q, 'init');
    console.log('  ok  reapply of an edited file, disable, init');
  }

  {
    // Refused as git refuses them.
    const p = new Pair('refused', seed('refused'));
    await p.run(['sparse-checkout', 'set', 'a']);
    for (const args of [
      ['sparse-checkout', 'set', '/a'], ['sparse-checkout', 'set', 'a*'], ['sparse-checkout', 'set', '!a'], ['sparse-checkout', 'set', 'top.txt'],
      ['sparse-checkout', 'add', 'b/y.txt'], ['sparse-checkout', 'frob'], ['sparse-checkout'], ['sparse-checkout', 'list', '--frob'],
      ['sparse-checkout', 'set', '--frob'], ['sparse-checkout', 'add', '--frob'], ['sparse-checkout', 'reapply', '--frob'],
      ['sparse-checkout', 'init', '--frob'], ['sparse-checkout', 'disable', '--frob'],
    ]) await p.run(args);
    p.same('refusals');
    await p.run(['sparse-checkout', 'set', '--skip-checks', 'top.txt']);
    p.same('set --skip-checks top.txt');
    sameFiles(p, 'set --skip-checks top.txt');
    console.log('  ok  refusals: a leading slash, a pattern, a \'!\', a file, an unknown subcommand or option, none');
  }

  {
    // From a subdirectory: an absolute path inside the repository is its directory; one outside is refused.
    const p = new Pair('absolute', seed('absolute'));
    await p.run(['sparse-checkout', 'set', 'a', 'b']);
    await p.run(['sparse-checkout', 'set', '{root}/c/e'], { sub: 'b' });
    p.same('set of an absolute path inside, from b/');
    sameFiles(p, 'set of an absolute path inside, from b/');
    await p.run(['sparse-checkout', 'set', '--skip-checks', '{root}/b/d'], { sub: 'b' });
    p.same('set --skip-checks of an absolute path inside, from b/');
    sameFiles(p, 'set --skip-checks of an absolute path inside, from b/');
    for (const outside of ['/', '{root}/../elsewhere', '{root}x/a']) {
      await p.run(['sparse-checkout', 'set', outside], { sub: 'b' });
      await p.run(['sparse-checkout', 'set', '--skip-checks', outside], { sub: 'b' });
    }
    p.same('refused paths outside, from b/');
    console.log('  ok  from a subdirectory: an absolute path inside is the repository\'s, one outside refused, --skip-checks or not');
  }

  {
    // Two sets at once: `set a` reaches its patterns' publication, `set b` starts then; host git, one after the other.
    const p = new Pair('concurrent', seed('concurrent'));
    sh(p.disk, ['sparse-checkout', 'set', 'a'], ['sparse-checkout', 'set', 'b']);
    let second = null;
    const first = nimbusGit(p.virtual, ['sparse-checkout', 'set', 'a'], {
      beforeWrite: async (path) => {
        if (!path.endsWith('/info/sparse-checkout') || second !== null) return;
        second = nimbusGit(p.virtual, ['sparse-checkout', 'set', 'b']);
        // Until the second is done, or long enough that it would be, unless it waits for this one.
        await Promise.race([second, sleep(500)]);
      },
    });
    const [a, b] = [await first, await second];
    assert.deepEqual([a.code, b.code], [0, 0], `${a.stderr}${b.stderr}`);
    p.same('two sets at once');
    sameFiles(p, 'two sets at once');
    console.log('  ok  two sets at once: the second sees the first\'s whole result');
  }

  {
    // Not supported here: non-cone mode and a sparse index, refused before anything changes.
    const p = new Pair('unsupported', seed('unsupported'));
    for (const [args, message] of [
      [['sparse-checkout', 'set', '--no-cone', 'a'], 'fatal: a sparse checkout without cone mode is not supported\n'],
      [['sparse-checkout', 'set', '--sparse-index', 'a'], 'fatal: a sparse index (--sparse-index) is not supported here\n'],
    ]) {
      const ran = await nimbusGit(p.virtual, args);
      assert.deepEqual([ran.code, ran.stderr], [128, message], args.join(' '));
    }
    assert.equal(realGit(p.copy(), ['config', '--get', 'core.sparseCheckout']).stdout, '', 'nothing changed');
    console.log('  ok  non-cone mode and a sparse index: refused, nothing changed');
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
console.log(`git-sparse-checkout: ok (${counts.checks} checks)`);
