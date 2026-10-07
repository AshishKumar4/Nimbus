#!/usr/bin/env bun
// `git clone` onto a mounted filesystem (a SqliteFiles on its own database,
// mounted at /mnt/data), against host git cloning the same repository over
// the same server: the same worktree, index (`ls-files -s`), refs and
// objects (fsck clean), with depth 1 and with history; files over a wave's
// 4 MiB mount limit included. A clone there that fails is removed, through
// the namespace. Then fetch, pull and push in the mounted repository, host
// git doing the same in its clone: the same refs, objects, worktree and
// index, and the server's branch where ours pushed it. A mount whose
// backend cannot rename fails the clone with ENOTSUP naming rename, and the
// destination is removed.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';

/** A mount whose backend cannot rename in place. */
class NoRename extends MemoryVFS { rename = undefined; }
import { startGitHttpServer } from './lib/git-http-server.mjs';
import { createFacetSession, hostGit as hostGitIn } from './lib/facet-session.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const work = mkdtempSync(join(tmpdir(), 'nimbus-clone-mount-'));
const hostGit = (cwd, args) => hostGitIn(work, cwd, args);

/** A worktree as a sorted list: each path (but .git), its kind and contents' length and head. */
function worktreeOf(dir) {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (rel === '' && name === '.git') continue;
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isSymbolicLink()) out.push([path, 'link', readlinkSync(join(dir, path))]);
      else if (st.isDirectory()) { out.push([path, 'dir']); walk(path); }
      else {
        const bytes = readFileSync(join(dir, path));
        out.push([path, (st.mode & 0o111) ? 'exec' : 'file', bytes.length, bytes.subarray(0, 64).toString('hex')]);
      }
    }
  };
  walk('');
  return out;
}

try {
  const source = join(work, 'source');
  hostGit(work, ['init', '-q', '-b', 'main', source]);
  const put = (path, data) => { mkdirSync(join(source, path, '..'), { recursive: true }); writeFileSync(join(source, path), data); };
  put('README.md', 'top\n');
  put('src/a.txt', 'a\n'.repeat(100));
  put('src/deep/b.txt', 'b\n');
  // Over a wave's 4 MiB mount limit (ROUTED_FILE_MAX), and not deltified away: random bytes.
  const big = new Uint8Array(6 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 65536) crypto.getRandomValues(big.subarray(i, i + 65536));
  put('assets/big.bin', big);
  hostGit(source, ['add', '-A']);
  hostGit(source, ['commit', '-q', '-m', 'one']);
  put('src/a.txt', 'a, again\n');
  hostGit(source, ['add', '-A']);
  hostGit(source, ['commit', '-q', '-m', 'two']);
  const served = join(work, 'served');
  mkdirSync(served);
  hostGit(work, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowFilter', 'true']);
  hostGit(join(served, 'repo.git'), ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  hostGit(join(served, 'repo.git'), ['config', 'http.receivepack', 'true']);
  const server = startGitHttpServer(served);

  const mountHarness = createSqliteVfsTestHarness();
  const mountEngine = new SqliteVFS(mountHarness.sql, mountHarness.ctx);
  // The session user's own directory on the mount.
  mountEngine.as(CRED_KERNEL).mkdir('work', { mode: 0o755 });
  mountEngine.as(CRED_KERNEL).chown('work', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const noRename = new NoRename({ uid: CRED_SESSION_USER.uid, gid: CRED_SESSION_USER.gid });
  const session = await createFacetSession(work, { realGit: true, mounts: {
    '/mnt/data': new SqliteFiles(mountEngine, mountEngine.as(CRED_KERNEL)),
    '/mnt/norename': noRename,
  } });
  try {
    // Host git's clone is the whole history without --depth: ours takes --no-shallow for it.
    for (const [name, args, hostArgs] of [['shallow', ['--depth', '1'], ['--depth', '1']], ['history', ['--no-shallow'], []]]) {
      const host = join(work, 'host-' + name);
      hostGit(work, ['clone', '-q', ...hostArgs, 'file://' + join(served, 'repo.git'), host]);
      const cloned = await session.git('/home/user', ['clone', ...args, server.url + '/repo.git', '/mnt/data/work/' + name]);
      assert.equal(cloned.code, 0, `${name}: ${cloned.stderr}`);
      const ours = await session.materializeAt('/mnt/data/work/' + name, join(work, 'ours-' + name));
      assert.deepEqual(worktreeOf(ours), worktreeOf(host), `${name}: the worktree`);
      assert.equal(hostGit(ours, ['ls-files', '-s']), hostGit(host, ['ls-files', '-s']), `${name}: the index`);
      assert.equal(hostGit(ours, ['status', '--porcelain']), '', `${name}: clean`);
      assert.equal(hostGit(ours, ['rev-parse', 'HEAD', 'origin/main']), hostGit(host, ['rev-parse', 'HEAD', 'origin/main']), `${name}: refs`);
      const fsck = spawnSync('git', ['fsck', '--full', '--no-dangling'], { cwd: ours, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(fsck.status, 0, `${name}: fsck: ${fsck.stdout}${fsck.stderr}`);
      assert.equal(session.kernel.exists('mnt/data/work/' + name), false, `${name}: nothing of it on the session's own filesystem`);
      console.log(`  ok  clone ${args.join(' ')} onto a mount: host git's worktree, index, refs; fsck clean; a 6 MiB file included`);
    }

    // A clone that fails while it checks out: its destination on the mount goes, as git's
    // remove_junk takes it (through the namespace, under the clone's lease), and its record.
    const realFetch = globalThis.fetch;
    let posts = 0;
    globalThis.fetch = async (input, init) => {
      if (init?.method === 'POST' && ++posts > 3) return new Response('refused', { status: 403 });
      return realFetch(input, init);
    };
    let failed;
    try {
      failed = await session.git('/home/user', ['clone', '--depth', '1', server.url + '/repo.git', '/mnt/data/work/failed'], {
        NIMBUS_GIT_BLOBS_PER_BATCH: '1', NIMBUS_GIT_BATCH_CONCURRENCY: '1', NIMBUS_GIT_CLONE_CLEANUP_SLICE: '3',
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.notEqual(failed.code, 0, 'the clone fails');
    assert.doesNotMatch(failed.stderr, /could not remove the failed clone/, failed.stderr.slice(-400));
    assert.equal(mountEngine.as(CRED_KERNEL).exists('work/failed'), false, 'its destination on the mount is gone');
    assert.equal((await session.doCtx.storage.list({ prefix: 'git-clone-job:' })).size, 0, 'and its record');
    console.log('  ok  a clone onto a mount that fails: its destination there removed, through the namespace');

    // fetch and pull in the mounted repository (its full clone), host git in its own: a new
    // commit with another file past a wave's mount limit.
    const big2 = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < big2.length; i += 65536) crypto.getRandomValues(big2.subarray(i, i + 65536));
    put('assets/big2.bin', big2);
    put('src/a.txt', 'a, a third time\n');
    hostGit(source, ['add', '-A']);
    hostGit(source, ['commit', '-q', '-m', 'three']);
    hostGit(source, ['push', '-q', join(served, 'repo.git'), 'main']);
    const hostHistory = join(work, 'host-history');
    const ident = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b' };
    const fetched = await session.git('/mnt/data/work/history', ['fetch', '-q'], ident);
    assert.equal(fetched.code, 0, `fetch: ${fetched.stderr}`);
    hostGit(hostHistory, ['fetch', '-q']);
    const afterFetch = await session.materializeAt('/mnt/data/work/history', join(work, 'ours-fetched'));
    assert.equal(hostGit(afterFetch, ['rev-parse', 'origin/main']), hostGit(hostHistory, ['rev-parse', 'origin/main']), 'fetch: origin/main');
    assert.equal(spawnSync('git', ['fsck', '--full', '--no-dangling'], { cwd: afterFetch, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).status, 0, 'fetch: fsck');
    console.log('  ok  fetch in a mounted repository: host git\'s refs; fsck clean');
    const pulled = await session.git('/mnt/data/work/history', ['pull', '-q'], ident);
    assert.equal(pulled.code, 0, `pull: ${pulled.stderr}`);
    hostGit(hostHistory, ['pull', '-q']);
    const afterPull = await session.materializeAt('/mnt/data/work/history', join(work, 'ours-pulled'));
    assert.deepEqual(worktreeOf(afterPull), worktreeOf(hostHistory), 'pull: the worktree');
    assert.equal(hostGit(afterPull, ['ls-files', '-s']), hostGit(hostHistory, ['ls-files', '-s']), 'pull: the index');
    assert.equal(hostGit(afterPull, ['rev-parse', 'HEAD']), hostGit(hostHistory, ['rev-parse', 'HEAD']), 'pull: HEAD');
    assert.equal(hostGit(afterPull, ['status', '--porcelain']), '', 'pull: clean');
    console.log('  ok  pull in a mounted repository: host git\'s worktree, index and HEAD, a 5 MiB file included');

    // push from the mounted repository: the server's main is ours.
    await session.files.view({ pid: 7, cred: CRED_SESSION_USER }).writeFile('/mnt/data/work/history/pushed.txt', new TextEncoder().encode('pushed\n'));
    for (const args of [['add', 'pushed.txt'], ['commit', '-q', '-m', 'pushed']]) {
      const step = await session.git('/mnt/data/work/history', args, ident);
      assert.equal(step.code, 0, `${args[0]}: ${step.stderr}`);
    }
    const pushed = await session.git('/mnt/data/work/history', ['push', '-q'], ident);
    assert.equal(pushed.code, 0, `push: ${pushed.stderr}`);
    const afterPush = await session.materializeAt('/mnt/data/work/history', join(work, 'ours-pushed'));
    assert.equal(hostGit(join(served, 'repo.git'), ['rev-parse', 'main']), hostGit(afterPush, ['rev-parse', 'HEAD']), 'push: the server\'s main is ours');
    assert.equal(spawnSync('git', ['fsck', '--full', '--no-dangling'], { cwd: join(served, 'repo.git'), env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).status, 0, 'push: the server fsck clean');
    console.log('  ok  push from a mounted repository: the server\'s main is our commit; fsck clean');

    // A backend that cannot rename: the clone fails, naming the operation, and leaves nothing.
    const refused = await session.git('/home/user', ['clone', '--depth', '1', server.url + '/repo.git', '/mnt/norename/repo']);
    assert.notEqual(refused.code, 0, 'a clone onto a mount that cannot rename fails');
    assert.match(refused.stderr, /ENOTSUP/, refused.stderr.slice(-400));
    assert.match(refused.stderr, /rename/, refused.stderr.slice(-400));
    assert.doesNotMatch(refused.stderr, /could not remove the failed clone/, refused.stderr.slice(-400));
    assert.deepEqual(noRename.readdir('/').map(({ name }) => name), [], 'and its destination is removed');
    console.log('  ok  a mount that cannot rename: the clone fails with ENOTSUP naming rename; nothing left');
  } finally {
    server.stop();
  }
  console.log('git-clone-mount: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
