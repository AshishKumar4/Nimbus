#!/usr/bin/env bun
// A clone that fails while it checks out (its blob pieces refused) leaves
// what a failed `git clone` leaves (git's remove_junk, builtin/clone.c),
// host git the oracle on the same destinations:
//   - a destination it made: gone, with every file it checked out and .git;
//   - its leading directories (nested/a of nested/a/repo): kept;
//   - a destination that existed, empty: kept, empty.
// The abort runs in pieces (40 entries each, so several), and finishes.
// Red before: the abort removed .git only, and the checked-out files stayed
// (staging, next.js --depth 1: 32,940 files with no .git).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  session.kernel.mkdir('home/user/empty', { mode: 0o755 });
  try {
    for (const dest of ['repo', 'nested/a/repo', 'empty']) {
      const abortsBefore = session.requests.phases.filter((phase) => phase === 'clone-abort').length;
      // The pack and the first blob pieces are served; then every request is refused.
      let posts = 0;
      globalThis.fetch = async (input, init) => {
        if (init?.method === 'POST' && ++posts > 6) return new Response('refused', { status: 403 });
        return realFetch(input, init);
      };
      const cloned = await session.git('/home/user', ['clone', '--depth', '1', server.url + '/repo.git', dest], {
        NIMBUS_GIT_BLOBS_PER_BATCH: '10',
        NIMBUS_GIT_BATCH_CONCURRENCY: '1',
        NIMBUS_GIT_CLONE_ABORT_PIECE_ENTRIES: '40',
      });
      globalThis.fetch = realFetch;
      assert.notEqual(cloned.code, 0, `${dest}: the clone fails`);
      assert.match(cloned.stderr, /HTTP 403/);
      const aborts = session.requests.phases.filter((phase) => phase === 'clone-abort').length - abortsBefore;
      assert.ok(aborts > 1, `${dest}: the abort ran in pieces (${aborts}): ${cloned.stderr.slice(-400)}`);
      assert.doesNotMatch(cloned.stderr, /could not remove the failed clone/, cloned.stderr.slice(-400));
      if (dest === 'empty') {
        assert.deepEqual(session.kernel.readdir('home/user/empty').map(({ name }) => name), [], 'a destination that existed: kept, empty');
      } else {
        assert.equal(session.kernel.exists('home/user/' + dest), false, `${dest}: removed, with its checked-out files and .git`);
      }
      if (dest === 'nested/a/repo') assert.equal(session.kernel.exists('home/user/nested/a'), true, 'its leading directories are kept');
      console.log(`  ok  ${dest}: as git leaves it (${aborts} abort invocations)`);
    }
  } finally {
    globalThis.fetch = realFetch;
    server.stop();
  }
  console.log('git-clone-abort-worktree: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
