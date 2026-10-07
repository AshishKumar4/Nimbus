#!/usr/bin/env bun
// A clone that fails while it checks out (its blob pieces refused) leaves
// what a failed `git clone` leaves (git's remove_junk, builtin/clone.c),
// host git the oracle on the same destinations:
//   - a destination it made: gone, with every file it checked out and .git;
//   - its leading directories (nested/a of nested/a/repo): kept;
//   - a destination that existed, empty: kept, empty.
// The cleanup runs in the DO in slices (40 entries each), and its record goes.
// A destination that is not empty (a file and an empty .git) is refused as
// host git refuses it, before the clone writes its record: none is written,
// and nothing there goes. A record that cannot be written refuses the clone
// and releases its lease: the next clone there runs.
// A partial clone whose checkout fails once its objects are in keeps the
// repository, with git's warning (JUNK_LEAVE_REPO), host git against the
// same refusing server the oracle.
// Red before: the abort removed .git only, and the checked-out files stayed
// (staging, next.js --depth 1: 32,940 files with no .git).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn } from './lib/facet-session.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-abort-worktree-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);

try {
  // 240 files in 12 directories: blob pieces of 10, so the checkout writes
  // files before the refused pieces fail it.
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  for (let d = 0; d < 12; d++) {
    mkdirSync(join(source, `dir${d}`, 'sub'), { recursive: true });
    for (let f = 0; f < 20; f++) writeFileSync(join(source, `dir${d}`, f % 2 ? 'sub' : '', `f${f}.txt`), `dir ${d} file ${f}\n`.repeat(30));
  }
  hostGit(source, ['add', '-A']);
  hostGit(source, ['commit', '-q', '-m', 'files']);
  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowFilter', 'true']);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  const server = startGitHttpServer(served);

  // Host git, failing on the same destinations (an unreachable remote):
  // what a failed clone leaves of each.
  const host = join(work, 'host');
  mkdirSync(join(host, 'empty'), { recursive: true });
  for (const dest of ['repo', 'nested/a/repo', 'empty']) {
    const failed = spawnSync('git', ['clone', 'http://127.0.0.1:1/none.git', dest], { cwd: host, encoding: 'utf8' });
    assert.notEqual(failed.status, 0);
  }
  assert.equal(existsSync(join(host, 'repo')), false, 'host git removes a destination it made');
  assert.equal(existsSync(join(host, 'nested/a')), true, 'host git keeps the leading directories');
  assert.equal(existsSync(join(host, 'nested/a/repo')), false);
  assert.deepEqual(readdirSync(join(host, 'empty')), [], 'host git keeps a destination that existed, emptied');

  const realFetch = globalThis.fetch;
  // One session, as a user's: each clone in it fails and is cleaned up in turn.
  const session = await createFacetSession(work);
  // The user's own empty directory: the clone, and its cleanup, act as the user.
  session.kernel.mkdir('home/user/empty', { mode: 0o755 });
  session.kernel.chown('home/user/empty', 1000, 1000);
  try {
    for (const dest of ['repo', 'nested/a/repo', 'empty']) {
      // The pack and the first blob pieces are served; then every request is refused.
      let posts = 0;
      globalThis.fetch = async (input, init) => {
        if (init?.method === 'POST' && ++posts > 6) return new Response('refused', { status: 403 });
        return realFetch(input, init);
      };
      const cloned = await session.git('/home/user', ['clone', '--depth', '1', server.url + '/repo.git', dest], {
        NIMBUS_GIT_BLOBS_PER_BATCH: '10',
        NIMBUS_GIT_BATCH_CONCURRENCY: '1',
        NIMBUS_GIT_CLONE_CLEANUP_SLICE: '40',
      });
      globalThis.fetch = realFetch;
      assert.notEqual(cloned.code, 0, `${dest}: the clone fails`);
      assert.match(cloned.stderr, /HTTP 403/);
      assert.doesNotMatch(cloned.stderr, /could not remove the failed clone|Clone succeeded/, cloned.stderr.slice(-400));
      assert.equal((await session.doCtx.storage.list({ prefix: 'git-clone-job:' })).size, 0, `${dest}: the clone's record went`);
      if (dest === 'empty') {
        assert.deepEqual(session.kernel.readdir('home/user/empty').map(({ name }) => name), [], 'a destination that existed: kept, empty');
      } else {
        assert.equal(session.kernel.exists('home/user/' + dest), false, `${dest}: removed, with its checked-out files and .git`);
      }
      if (dest === 'nested/a/repo') assert.equal(session.kernel.exists('home/user/nested/a'), true, 'its leading directories are kept');
      console.log(`  ok  ${dest}: as git leaves it`);
    }

    // A destination that is not empty: refused before any record is written.
    mkdirSync(join(host, 'busy/.git'), { recursive: true });
    writeFileSync(join(host, 'busy/notes.txt'), 'mine\n');
    const hostBusy = spawnSync('git', ['clone', 'http://127.0.0.1:1/none.git', 'busy'], { cwd: host, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(hostBusy.status, 128, hostBusy.stderr);
    session.kernel.mkdir('home/user/busy/.git', { recursive: true, mode: 0o755 });
    session.kernel.chown('home/user/busy', 1000, 1000);
    session.kernel.chown('home/user/busy/.git', 1000, 1000);
    session.kernel.writeFile('home/user/busy/notes.txt', 'mine\n');
    const storage = session.doCtx.storage;
    const put = storage.put;
    const puts = [];
    storage.put = async (key, value) => { puts.push(key); return await put.call(storage, key, value); };
    const busy = await session.git('/home/user', ['clone', server.url + '/repo.git', 'busy']);
    storage.put = put;
    assert.equal(busy.code, 128, busy.stderr);
    assert.equal(busy.stderr, hostBusy.stderr, 'host git\'s refusal');
    assert.deepEqual(puts, [], 'no record was written');
    assert.ok(session.kernel.exists('home/user/busy/.git') && session.kernel.readFileString('home/user/busy/notes.txt') === 'mine\n', 'nothing there went');
    console.log('  ok  a destination that is not empty: host git\'s refusal, before any record; nothing there touched');

    // A record that cannot be written: the clone refuses, and its lease goes with it.
    storage.put = async () => { throw new Error('storage unavailable'); };
    const unrecorded = await session.git('/home/user', ['clone', '--depth', '1', server.url + '/repo.git', 'unrecorded']);
    storage.put = put;
    assert.equal(unrecorded.code, 128, unrecorded.stderr);
    assert.equal(unrecorded.stderr, 'fatal: could not record the clone: storage unavailable\n');
    const again = await session.git('/home/user', ['clone', '--depth', '1', server.url + '/repo.git', 'unrecorded']);
    assert.equal(again.code, 0, `the next clone there runs: ${again.stderr}`);
    assert.ok(session.kernel.exists('home/user/unrecorded/dir0/f0.txt'), 'and checks out');
    console.log('  ok  a record that cannot be written: refused, the lease released; the next clone there runs');
  } finally {
    globalThis.fetch = realFetch;
    server.stop();
  }

  // A partial clone whose checkout fails once its objects are in (the
  // server refuses every fetch of its blobs): git keeps the repository
  // and says so (JUNK_LEAVE_REPO). Host git against the same refusing
  // server is the oracle (spawned, not run synchronously: the server is
  // this process's).
  // Every fetch that wants anything but the branch's commit: the blobs the checkout needs.
  const tip = hostGit(join(served, 'repo.git'), ['rev-parse', 'HEAD']).trim();
  const refusing = startGitHttpServer(served, {
    refuse: (path, body) => path.endsWith('/git-upload-pack')
      && [...new TextDecoder().decode(body).matchAll(/want ([0-9a-f]{40})/g)].some(([, oid]) => oid !== tip),
  });
  try {
    const hostRun = await new Promise((resolve) => {
      const child = spawn('git', ['clone', '--depth', '1', '--filter=blob:none', refusing.url + '/repo.git', 'partial'], { cwd: host, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stderr }));
    });
    const LEAVE_REPO = "warning: Clone succeeded, but checkout failed.\nYou can inspect what was checked out with 'git status'\nand retry with 'git restore --source=HEAD :/'\n\n";
    assert.equal(hostRun.status, 128, hostRun.stderr);
    assert.ok(hostRun.stderr.endsWith(LEAVE_REPO), `host git: ${hostRun.stderr}`);
    const cloned = await session.git('/home/user', ['clone', '--depth', '1', '--filter=blob:none', refusing.url + '/repo.git', 'partial']);
    assert.notEqual(cloned.code, 0);
    assert.ok(cloned.stderr.endsWith(LEAVE_REPO), `ours: ${cloned.stderr.slice(-600)}`);
    const ours = session.materialize('home/user/partial', join(work, 'ours-partial'));
    const hostDir = join(host, 'partial');
    const listing = (dir, rel = '') => readdirSync(join(dir, rel)).sort().flatMap((name) => {
      const path = rel ? `${rel}/${name}` : name;
      if (path === '.git/objects' || path === '.git/hooks' || path === '.git/logs' || path === '.git/description' || path === '.git/info') return [];
      return lstatSync(join(dir, path)).isDirectory() ? [path + '/', ...listing(dir, path)] : [path];
    });
    assert.deepEqual(listing(ours), listing(hostDir), 'the repository and worktree git leaves');
    assert.equal(hostGit(ours, ['status', '--porcelain']), hostGit(hostDir, ['status', '--porcelain']), 'the status git leaves');
    assert.equal(readFileSync(join(ours, '.git/HEAD'), 'utf8'), readFileSync(join(hostDir, '.git/HEAD'), 'utf8'));
    assert.equal((await session.doCtx.storage.list({ prefix: 'git-clone-job:' })).size, 0, 'the record went');
    console.log('  ok  a partial clone whose checkout fails: the repository kept, as git keeps it, and git\'s warning');
  } finally {
    refusing.stop();
  }
  console.log('git-clone-abort-worktree: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
