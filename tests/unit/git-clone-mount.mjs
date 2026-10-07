#!/usr/bin/env bun
// `git clone` onto a mounted filesystem (a SqliteFiles on its own database,
// mounted at /mnt/data), against host git cloning the same repository over
// the same server: the same worktree, index (`ls-files -s`), refs and
// objects (fsck clean), with depth 1 and with history; files over a wave's
// 4 MiB mount limit included.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
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
  const server = startGitHttpServer(served);

  const mountHarness = createSqliteVfsTestHarness();
  const mountEngine = new SqliteVFS(mountHarness.sql, mountHarness.ctx);
  // The session user's own directory on the mount.
  mountEngine.as(CRED_KERNEL).mkdir('work', { mode: 0o755 });
  mountEngine.as(CRED_KERNEL).chown('work', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const session = await createFacetSession(work, { mounts: { '/mnt/data': new SqliteFiles(mountEngine, mountEngine.as(CRED_KERNEL)) } });
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
  } finally {
    server.stop();
  }
  console.log('git-clone-mount: ok');
} finally {
  rmSync(work, { recursive: true, force: true });
}
