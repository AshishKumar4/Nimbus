#!/usr/bin/env bun
// Which paths git ignores: Nimbus's port of dir.c's exclude rules and
// wildmatch.c (packages/worker/src/git/worktree/{excludes,wildmatch}.ts)
// answers what real git's check-ignore answers, path for path, on a tree of
// files and directories under .gitignore files at three levels and
// info/exclude: negations, anchors, `**` at every position, directory-only
// patterns, character classes and ranges, escapes, trailing spaces, CRLF
// lines, a BOM, and the rule that nothing below an excluded directory comes
// back. With core.ignorecase, the same answers as git's: `*.LOG` ignores a.log.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Excludes, parsePatternList } from '../../packages/worker/src/git/worktree/excludes.ts';

const scratch = mkdtempSync(join(tmpdir(), 'nimbus-git-excludes-'));
try {
  const repo = join(scratch, 'repo');
  mkdirSync(repo);
  const git = (...args) => {
    const r = spawnSync('git', args, {
      cwd: repo, input: args.includes('--stdin') ? undefined : undefined,
      env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    });
    return r;
  };
  assert.equal(git('init', '-q').status, 0);

  const gitignore = [
    '\ufeff# a BOM first, then a comment',
    '*.log', '!keep.log', 'build/', '/root-only', 'doc/**/*.pdf', '**/gen', 'a/**/z', 'lit\\*star', '\\#hash', '\\!bang',
    'trail\\ ', 'spaces   ', '[abc]x', '[!a-c]y', 'q[[:digit:]]', 'r[[:alpha:]-]', 'deep/*/one', 'cr-line\r', '*.tmp/',
    'odd?', '**/cachedir/', 'nested/**', '!nested/keep/', 'x/y/**/w', 'm*n/o', '*.LOG', 'Upper/', '[[:upper:]]z', '[A-C]w',
    '/MixedCase/Inner', '\\', '',
  ].join('\n');
  writeFileSync(join(repo, '.gitignore'), gitignore);
  mkdirSync(join(repo, 'sub/inner'), { recursive: true });
  writeFileSync(join(repo, 'sub/.gitignore'), 'local\n!debug.log\n/anchored\ninner/\n*.c\n!special.c\n');
  writeFileSync(join(repo, 'sub/inner/.gitignore'), '!*.c\n');
  writeFileSync(join(repo, '.git/info/exclude'), 'from-info\n*.excl\n!sub/keep.excl\n');

  const files = [
    'debug.log', 'keep.log', 'sub/debug.log', 'sub/deep/keep.log', 'build/out', 'sub/build/out', 'build', 'root-only', 'sub/root-only',
    'doc/x.pdf', 'doc/a/b/x.pdf', 'doc/x.txt', 'gen/f', 'src/gen/f', 'src/gen', 'a/z', 'a/b/c/z', 'a/b/z/q', 'lit*star', 'litXstar',
    '#hash', '!bang', 'trail ', 'trail', 'spaces', 'ax', 'dx', 'ay', 'dy', 'q1', 'qx', 'rk', 'r-', 'r1', 'deep/two/one', 'deep/one',
    'deep/a/b/one', 'cr-line', 'f.tmp/x', 'f.tmp', 'odd1', 'odd', 'nested/a', 'nested/keep/b', 'x/y/w', 'x/y/p/q/w', 'mxn/o', 'mn/o',
    'sub/local', 'sub/inner/local', 'sub/anchored', 'sub/inner/anchored', 'sub/inner/f', 'sub/a.c', 'sub/special.c', 'sub/inner/b.c',
    'from-info', 'sub/from-info', 'x.excl', 'sub/keep.excl', 'plain.txt', 'sub/plain.txt', 'cachedir/f', 'sub/cachedir/f', 'cachedir2/f',
    'a.log', 'B.Log', 'C.LOG', 'KEEP.LOG', 'upper/f', 'UPPER/f', 'Upper/f', 'az', 'Az', 'bw', 'Bw', 'mixedcase/inner', 'MIXEDCASE/INNER',
    'BUILD/out', 'Doc/A/x.PDF', 'SUB/LOCAL', 'sub/LOCAL',
  ];
  for (const file of files) {
    const path = join(repo, file);
    mkdirSync(join(path, '..'), { recursive: true });
    try { writeFileSync(path, 'x\n'); } catch { /* a directory already has the name */ }
  }
  // Every file, and every directory on the way to one.
  const paths = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i <= parts.length; i++) paths.add(parts.slice(0, i).join('/'));
  }
  const all = [...paths].sort();
  const counts = [];
  for (const ignoreCase of [false, true]) {
    const checked = spawnSync('git', ['-c', `core.ignorecase=${ignoreCase}`, 'check-ignore', '--stdin', '-z'], {
      cwd: repo, input: all.map((p) => `${p}\0`).join(''),
      env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
    });
    assert.ok(checked.status === 0 || checked.status === 1, checked.stderr.toString());
    const expected = new Set(checked.stdout.toString().split('\0').filter(Boolean));

    const excludes = new Excludes(async (dir) => {
      try { return new Uint8Array(readFileSync(join(repo, dir, '.gitignore'))); } catch { return null; }
    }, [[], parsePatternList(new Uint8Array(readFileSync(join(repo, '.git/info/exclude'))), '')], ignoreCase);
    const actual = new Set();
    for (const path of all) {
      if (await excludes.isExcluded(path, statSync(join(repo, path)).isDirectory())) actual.add(path);
    }
    const differ = all.filter((path) => expected.has(path) !== actual.has(path))
      .map((path) => `${path}: git ${expected.has(path) ? 'ignores' : 'keeps'} it, Nimbus ${actual.has(path) ? 'ignores' : 'keeps'} it`);
    assert.deepEqual(differ, [], `every path as git check-ignore answers it (core.ignorecase=${ignoreCase})`);
    assert.ok(expected.size > 30 && expected.size < all.length - 10, `a mix of ignored (${expected.size}) and kept paths`);
    if (ignoreCase) assert.ok(expected.has('a.log') && expected.has('C.LOG'), '*.LOG ignores a.log under core.ignorecase');
    counts.push(expected.size);
  }
  console.log(`git-excludes-match-git: ${all.length} paths, ${counts[0]} ignored (${counts[1]} with core.ignorecase), as git check-ignore answers`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
