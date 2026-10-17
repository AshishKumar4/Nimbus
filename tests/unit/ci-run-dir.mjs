#!/usr/bin/env bun
// scripts/ci/lib/run-dir.mjs: a CI run's own files (its baseline checkouts,
// the releases it uploads) sit in one directory under the state root, and
// nothing piles up however runs end:
//   - a run that ends deletes its directory and the worktrees in it;
//   - the next run deletes what a killed run left, and nothing of a run
//     still alive;
//   - a process the run handed its lock to keeps the directory while it
//     lives, though the run itself was killed;
//   - a directory a run kept for a human to finish stays, and no sweep
//     makes a lock for it.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'ci-run-dir-'));
process.env.XDG_STATE_HOME = join(root, 'state');
const { openRunDir } = await import('../../scripts/ci/lib/run-dir.mjs');
const { RUNS } = await import('../../scripts/ci/lib/state-dir.mjs');

const git = (cwd, args) => {
  const done = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(done.status, 0, `git ${args.join(' ')}: ${done.stderr}`);
  return done.stdout;
};
const repo = join(root, 'checkout');
const worktrees = () => git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
const runDir = new URL('../../scripts/ci/lib/run-dir.mjs', import.meta.url).href;
/**
 * A run in another process: it opens its directory, makes a worktree and a
 * file in it, and, with `handOver`, starts a process holding its lock, which
 * outlives it. It says where (and the process's pid), and lives on until killed.
 */
const otherRun = ({ handOver = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', `
    const { spawn, spawnSync } = await import('node:child_process');
    const { writeFileSync } = await import('node:fs');
    const { openRunDir } = await import(${JSON.stringify(runDir)});
    const run = openRunDir(${JSON.stringify(repo)}, () => {});
    spawnSync('git', ['worktree', 'add', '--detach', run.dir + '/checkout-base', 'HEAD'], { cwd: ${JSON.stringify(repo)} });
    writeFileSync(run.dir + '/release.js', 'bundle');
    const held = ${handOver} ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: run.stdio(['ignore', 'ignore', 'ignore']), detached: true }) : null;
    console.log(JSON.stringify({ dir: run.dir, held: held?.pid ?? null }));
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.once('data', (data) => resolve({ child, ...JSON.parse(String(data)) }));
  child.once('exit', (code) => reject(new Error(`the other run exited ${code} before it opened its directory`)));
});
const ended = (child) => new Promise((resolve) => child.once('exit', resolve));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

try {
  git(root, ['init', '-q', repo]);
  writeFileSync(join(repo, 'README'), 'fixture\n');
  git(repo, ['add', 'README']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture']);

  {
    const run = openRunDir(repo, () => {});
    assert.equal(RUNS, join(root, 'state', 'nimbus', 'runs'), 'runs live under the state root, where XDG_STATE_HOME puts it');
    assert.ok(run.dir.startsWith(`${RUNS}/`));
    git(repo, ['worktree', 'add', '--detach', join(run.dir, 'checkout-base'), 'HEAD']);
    writeFileSync(join(run.dir, 'release.js'), 'bundle');
    assert.deepEqual(run.close(), []);
    assert.ok(!existsSync(run.dir) && !existsSync(`${run.dir}.lock`), 'a run that ends deletes its directory');
    assert.deepEqual(worktrees(), [repo], 'and the worktrees in it');
    console.log('  ok  a run that ends deletes its directory and the worktrees in it');
  }

  {
    const killed = await otherRun();
    const live = await otherRun();
    killed.child.kill('SIGKILL');
    await ended(killed.child);
    const run = openRunDir(repo, () => {});
    assert.ok(!existsSync(killed.dir) && !existsSync(`${killed.dir}.lock`), 'the next run deletes what a killed run left');
    assert.ok(!worktrees().includes(join(killed.dir, 'checkout-base')), 'and its worktree');
    assert.ok(existsSync(join(live.dir, 'release.js')) && worktrees().includes(join(live.dir, 'checkout-base')), 'and nothing of a run still alive');
    live.child.kill('SIGKILL');
    await ended(live.child);
    assert.deepEqual(run.close(), []);
    openRunDir(repo, () => {}).close();
    assert.ok(!existsSync(live.dir), 'once that run is killed too, the next run deletes its files');
    assert.deepEqual(worktrees(), [repo]);
    console.log('  ok  the next run deletes what a killed run left, and nothing of a live one');
  }

  {
    const handed = await otherRun({ handOver: true });
    handed.child.kill('SIGKILL');
    await ended(handed.child);
    assert.ok(alive(handed.held), 'the process the run handed its lock to outlives it');
    openRunDir(repo, () => {}).close();
    assert.ok(existsSync(join(handed.dir, 'release.js')), 'while it lives, the killed run\'s directory stays');
    process.kill(handed.held, 'SIGKILL');
    for (let i = 0; i < 100 && alive(handed.held); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    openRunDir(repo, () => {}).close();
    assert.ok(!existsSync(handed.dir), 'once it ends, the next run deletes it');
    console.log('  ok  a process holding the run\'s lock keeps its directory after the run is killed');
  }

  {
    const kept = openRunDir(repo, () => {});
    writeFileSync(join(kept.dir, 'release.js'), 'bundle');
    const [line] = kept.keep();
    assert.ok(line.includes(kept.dir), line);
    openRunDir(repo, () => {}).close();
    assert.ok(existsSync(join(kept.dir, 'release.js')) && existsSync(`${kept.dir}.kept`), 'a kept directory stays for whoever finishes it');
    assert.deepEqual(readdirSync(RUNS).filter((name) => name.endsWith('.lock')), [], 'and no sweep makes a lock for it');
    console.log('  ok  a directory a run kept stays');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
