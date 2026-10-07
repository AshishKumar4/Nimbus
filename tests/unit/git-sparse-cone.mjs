#!/usr/bin/env bun
// Cone-mode sparse checkout (git/pack/sparse.ts) against host git: for sets
// of directories, `git sparse-checkout set <dirs>` in a repository with
// files at every level is the oracle for which paths the worktree holds
// (`ls-files -t`: H in, S out) and for the info/sparse-checkout file, which
// coneSparseCheckout writes byte for byte and parseConeSparseCheckout reads
// back as the cone coneOf makes. Files written by hand (the full cone "/*",
// a parent left out, CR LF, an escaped name) are read as `git sparse-checkout
// reapply` reads them, and under core.ignoreCase paths compare as git's do;
// what is not a cone pattern is not read as one.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { coneMatcher, coneOf, coneSparseCheckout, parseConeSparseCheckout } from '../../packages/worker/src/git/pack/sparse.ts';

const work = mkdtempSync(join(tmpdir(), 'nimbus-sparse-cone-'));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' } });

try {
  const repo = join(work, 'repo');
  git(work, ['init', '-q', '-b', 'main', repo]);
  const files = ['top.txt', 'a/x', 'a/b/y', 'a/b/c/z', 'a/bb/w', 'a b/q', 'c/z', 'd/e/f/g', 'd/e/h', 'd/i', 'x*y/j', 'deep/1/2/3/4'];
  for (const file of files) {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), file + '\n');
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'all']);
  const sets = [[], ['a'], ['a/b'], ['a/b', 'c'], ['a b', 'd/e/f'], ['a', 'a/b'], ['d/e', 'd/e/f'], ['deep/1/2'], ['x*y']];
  for (const dirs of sets) {
    // A directory with a glob character in its name takes --skip-checks, as git asks.
    git(repo, ['sparse-checkout', 'set', '--cone', ...(dirs.some((dir) => /[*?[\]\\]/.test(dir)) ? ['--skip-checks'] : []), ...dirs]);
    const file = readFileSync(join(repo, '.git/info/sparse-checkout'), 'utf8');
    assert.equal(coneSparseCheckout(dirs), file, `set ${JSON.stringify(dirs)}: the sparse-checkout file`);
    const parsed = parseConeSparseCheckout(file);
    assert.ok(parsed !== null, `set ${JSON.stringify(dirs)}: cone-shaped`);
    assert.deepEqual(parsed, coneOf(dirs), `set ${JSON.stringify(dirs)}: the cone read back is the one set makes`);
    const matcher = coneMatcher(parsed);
    const expected = git(repo, ['ls-files', '-t']).trim().split('\n').map((line) => [line.slice(2), line[0] === 'H']);
    for (const [path, inside] of expected) assert.equal(matcher.includes(path), inside, `set ${JSON.stringify(dirs)}: ${path}`);
    // A directory the worktree holds: one with a file of the cone below it.
    for (const dir of new Set(files.flatMap((f) => f.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))) {
      const holds = expected.some(([path, inside]) => inside && path.startsWith(dir + '/'));
      if (holds) assert.equal(matcher.directory(dir), true, `set ${JSON.stringify(dirs)}: directory ${dir}`);
    }
  }
  console.log(`  ok  ${sets.length} cones: host git's sparse-checkout file and in/out paths`);

  // Written by hand, applied by `git sparse-checkout reapply`: the worktree it holds is the matcher's.
  const handWritten = [
    { file: '/*\n', label: 'the full cone' },
    { file: '/*\n!/*/\n/*\n', label: 'the full cone again after its negation' },
    { file: '/*\n!/*/\n/a/b/\n', label: 'a recursive directory without its parents' },
    { file: '/*\r\n!/*/\r\n/a/\r\n!/a/*/\r\n/a/b/\r\n', label: 'CR LF lines' },
    { file: '/*\n!/*/\n/x\\*y/\n', label: 'an escaped glob character' },
    { file: '/*\n!/*/\n/A/\n!/A/*/\n/A/B/\n/D/\n', label: 'other case, core.ignoreCase', ignoreCase: true },
    { file: '/*\n!/*/\n/A/\n', label: 'other case, case-sensitive' },
    { file: '# a comment\n/*\n!/*/\n\n/c/  \n', label: 'comments, blank lines and trailing spaces' },
  ];
  for (const { file, label, ignoreCase = false } of handWritten) {
    writeFileSync(join(repo, '.git/info/sparse-checkout'), file);
    git(repo, ['-c', `core.ignorecase=${ignoreCase}`, 'sparse-checkout', 'reapply']);
    const cone = parseConeSparseCheckout(file);
    assert.ok(cone !== null, `${label}: cone-shaped`);
    const matcher = coneMatcher(cone, ignoreCase);
    for (const line of git(repo, ['ls-files', '-t']).trim().split('\n')) {
      assert.equal(matcher.includes(line.slice(2)), line[0] === 'H', `${label}: ${line.slice(2)}`);
    }
  }
  console.log(`  ok  ${handWritten.length} sparse-checkout files written by hand: host git's in/out paths`);

  for (const file of ['/*\n!/*/\n*.txt\n', '/*\n!/*/\n!/a/*/\n', '/*\n!/*/\n/a/**/\n', '/*\n!/*/\n/a\n', '/*\n!/*/\n/a*/\n', '/*\n!/*/\n/a/\n!/a/*/\n/a/\n']) {
    assert.equal(parseConeSparseCheckout(file), null, `not cone patterns: ${JSON.stringify(file)}`);
  }
  console.log('  ok  what is not a cone pattern is not read as one');
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log('git-sparse-cone: ok');
