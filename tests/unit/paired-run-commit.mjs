#!/usr/bin/env bun
// The commit a paired CPU run sends (scripts/ci/lib/paired-cpu.mjs
// pairedRunCommit): the measured revision's tree, with this checkout's bench
// harness laid over it (the bench and the tests/ and scripts/ files it
// imports, transitively; none of packages/), so an older revision is measured
// with the bench as it is now, and the baseline's whole tree under the run's
// baseline directory.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { benchHarness, pairedRunCommit } from '../../scripts/ci/lib/paired-cpu.mjs';

const root = mkdtempSync(join(tmpdir(), 'paired-run-commit-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const put = (at, path, text) => {
  mkdirSync(dirname(join(at, path)), { recursive: true });
  writeFileSync(join(at, path), text);
};

try {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  // The baseline, and an older revision whose bench is the old protocol's.
  put(repo, 'packages/p/src/m.ts', "export const side = 'baseline';\n");
  put(repo, 'tests/bench/x-cpu.mjs', "import './lib/old.mjs';\n");
  put(repo, 'tests/bench/lib/old.mjs', 'export {};\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'baseline');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  put(repo, 'packages/p/src/m.ts', "export const side = 'revision';\n");
  git(repo, 'commit', '-q', '-am', 'revision');
  const revision = git(repo, 'rev-parse', 'HEAD');

  // This checkout: the bench as it is now, and what it imports.
  const from = join(root, 'checkout');
  put(from, 'tests/bench/x-cpu.mjs', [
    "import { a } from './lib/new.mjs';",
    "import { s } from '../../scripts/lib/s.mjs';",
    "import { side } from '../../packages/p/src/m.ts';",
    "const lazy = () => import('../unit/lib/h.mjs');",
    "export { a, s, side, lazy };",
  ].join('\n'));
  put(from, 'tests/bench/lib/new.mjs', "export * from './deeper.mjs';\nexport const a = 1;\n");
  put(from, 'tests/bench/lib/deeper.mjs', 'export const d = 1;\n');
  put(from, 'scripts/lib/s.mjs', 'export const s = 1;\n');
  put(from, 'tests/unit/lib/h.mjs', 'export {};\n');
  put(from, 'packages/p/src/m.ts', "export const side = 'checkout';\n");

  assert.deepEqual(benchHarness('tests/bench/x-cpu.mjs', from), [
    'scripts/lib/s.mjs', 'tests/bench/lib/deeper.mjs', 'tests/bench/lib/new.mjs', 'tests/bench/x-cpu.mjs', 'tests/unit/lib/h.mjs',
  ], "the bench and the tests/ and scripts/ files it imports, transitively; none of packages/");

  const run = pairedRunCommit({ repo, revision, baseline, baselineDir: '.ci-x-baseline', bench: 'tests/bench/x-cpu.mjs', from });
  const show = (path) => git(repo, 'show', `${run}:${path}`);
  assert.equal(git(repo, 'rev-parse', `${run}^`), revision);
  assert.match(show('tests/bench/x-cpu.mjs'), /lib\/new\.mjs/, "the bench is this checkout's");
  assert.equal(show('tests/bench/lib/deeper.mjs'), 'export const d = 1;');
  assert.equal(show('scripts/lib/s.mjs'), 'export const s = 1;');
  assert.equal(show('packages/p/src/m.ts'), "export const side = 'revision';", "the measured code is the revision's");
  assert.equal(git(repo, 'rev-parse', `${run}:.ci-x-baseline`), git(repo, 'rev-parse', `${baseline}^{tree}`), "the baseline's whole tree");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('paired-run-commit: ok');
