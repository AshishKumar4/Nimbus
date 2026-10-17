#!/usr/bin/env bun
// scripts/ci/lib/run-dir.mjs: a CI run's own files (its baseline checkouts,
// the releases it uploads) sit in one directory beside the checkout that
// runs it, and nothing piles up however runs end:
//   - a run that ends deletes its directory and the worktrees in it;
//   - the next run deletes what a killed run left, and nothing of a run
//     still alive;
//   - a directory a run kept for a human to finish stays.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openRunDir, runsRoot } from '../../scripts/ci/lib/run-dir.mjs';

const git = (cwd, args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout;
};
const worktrees = (repo) => git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));

const root = mkdtempSync(join(tmpdir(), 'ci-run-dir-'));
const repo = join(root, 'checkout');
const runDir = new URL('../../scripts/ci/lib/run-dir.mjs', import.meta.url).href;
/** A run in another process: it opens its directory, makes a worktree and a file in it, says where, and lives on until killed. */
const otherRun = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', `
    const { spawnSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const { openRunDir } = await import(${JSON.stringify(runDir)});
    const run = openRunDir(${JSON.stringify(repo)}, () => {});
    spawnSync('git', ['worktree', 'add', '--detach', run.dir + '/checkout-base', 'HEAD'], { cwd: ${JSON.stringify(repo)} });
    writeFileSync(run.dir + '/release.js', 'bundle');
    console.log(run.dir);
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.once('data', (data) => resolve({ child, dir: String(data).trim() }));
  child.once('exit', (code) => reject(new Error(`the other run exited ${code} before it opened its directory`)));
});
const ended = (child) => new Promise((resolve) => child.once('exit', resolve));

try {
  git(root, ['init', '-q', repo]);
  writeFileSync(join(repo, 'README'), 'fixture\n');
  git(repo, ['add', 'README']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture']);

  {
    const run = openRunDir(repo, () => {});
    assert.ok(run.dir.startsWith(`${runsRoot(repo)}/`), 'a run keeps its files beside the checkout that runs it');
    assert.equal(runsRoot(repo), join(root, '.nimbus-runs'));
    git(repo, ['worktree', 'add', '--detach', join(run.dir, 'checkout-base'), 'HEAD']);
    writeFileSync(join(run.dir, 'release.js'), 'bundle');
    assert.deepEqual(run.close(), []);
    assert.ok(!existsSync(run.dir) && !existsSync(`${run.dir}.lock`), 'a run that ends deletes its directory');
    assert.deepEqual(worktrees(repo), [repo], 'and the worktrees in it');
    console.log('  ok  a run that ends deletes its directory and the worktrees in it');
  }

  {
    const killed = await otherRun();
    const alive = await otherRun();
    killed.child.kill('SIGKILL');
    await ended(killed.child);
    const run = openRunDir(repo, () => {});
    assert.ok(!existsSync(killed.dir) && !existsSync(`${killed.dir}.lock`), 'the next run deletes what a killed run left');
    assert.ok(!worktrees(repo).includes(join(killed.dir, 'checkout-base')), 'and its worktree');
    assert.ok(existsSync(join(alive.dir, 'release.js')) && worktrees(repo).includes(join(alive.dir, 'checkout-base')), 'and nothing of a run still alive');
    alive.child.kill('SIGKILL');
    await ended(alive.child);
    assert.deepEqual(run.close(), []);
    const next = openRunDir(repo, () => {});
    assert.ok(!existsSync(alive.dir), 'once that run is killed too, the next run deletes its files');
    assert.deepEqual(worktrees(repo), [repo]);
    next.close();
    console.log('  ok  the next run deletes what a killed run left, and nothing of a live one');
  }

  {
    const kept = openRunDir(repo, () => {});
    writeFileSync(join(kept.dir, 'release.js'), 'bundle');
    const [line] = kept.keep();
    assert.ok(line.includes(kept.dir), line);
    openRunDir(repo, () => {}).close();
    assert.ok(existsSync(join(kept.dir, 'release.js')) && existsSync(`${kept.dir}.kept`), 'a kept directory stays for whoever finishes it');
    console.log('  ok  a directory a run kept stays');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
