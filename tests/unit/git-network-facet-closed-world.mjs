// The git facet against a real session VFS (SQLite) and a real git server
// (http-backend with its defaults: the clone takes one pack, decodes it, and
// checks it out in batches that read from it). What the facet may and may
// not do to the session:
//
//   - a clone's first wave makes its ownership marker durable; the marker
//     is gone when the clone is; no wave passes the W7 path or byte limits;
//     symlinks share waves; modes, links and gitlinks land as git's do;
//   - a destination that is not an empty directory (a file, a symlink, a
//     symlinked or file ancestor, a legacy symlink below it, an existing
//     repository) is refused before anything is written, and no abort runs;
//   - missing parents are created under the clone's lease before the clone
//     writes below them; an existing empty root keeps its directory mode;
//   - an abort removes only a clone whose marker names its job; any other
//     marker, or none, is left byte for byte;
//   - a phase past its deadline writes nothing;
//   - a fetch's stats and listings fall through to the session below the
//     repository, and its pending writes keep their modes.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  decodeWriteBatchStream,
  W7_MAX_OWNED_PATH_BYTES,
  W7_MAX_PATHS_PER_BATCH,
} from '../../packages/platform/src/w7-frame.ts';
import { assembleGitNetworkFacetSource, execGitNetwork } from '../../packages/worker/src/git/network-facet.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { getSymlinkRegistry } from '../../packages/core/src/vfs/symlink-registry.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { startGitHttpServer } from './lib/git-http-server.mjs';
import { hostGit as hostGitIn } from './lib/facet-session.mjs';

const tempDir = mkdtempSync(join(tmpdir(), 'nimbus-git-facet-closed-world-'));
const hostGit = (cwd, args) => hostGitIn(tempDir, cwd, args);

async function drainWave(stream) {
  const decoded = await decodeWriteBatchStream(stream);
  const paths = [];
  for await (const record of decoded.records) {
    if (record.type === 'directory' || record.type === 'file-begin' || record.type === 'symlink') {
      paths.push(record.inode.path);
    } else if (record.type === 'delete') {
      paths.push(record.path);
    } else if (record.type === 'file-chunk') {
      record.retention.release();
    }
  }
  return paths;
}

function byteStream(bytes) {
  return new ReadableStream({
    type: 'bytes',
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function supervisorStat(type, size = 0, mode = type === 'directory' ? 0o755 : 0o644) {
  const now = Date.now();
  return { type, size, mode, atime: now, ctime: now, mtime: now };
}

let server;
try {
  // ── The served repository: many files, a long name, modes, links, a gitlink ──
  const source = join(tempDir, 'source');
  hostGit(tempDir, ['init', '-q', '-b', 'main', source]);
  mkdirSync(join(source, 'src'));
  mkdirSync(join(source, 'concurrent'));
  mkdirSync(join(source, 'real-dir'));
  for (let i = 0; i < 260; i++) writeFileSync(join(source, `src/file-${i}.txt`), `file-${i}`);
  for (let i = 0; i < 180; i++) writeFileSync(join(source, `concurrent/file-${i}`), `concurrent-${i}`);
  // Paths of ~620 bytes, so a few fill a wave's owned-path bytes.
  const longDir = 'long/' + ['x', 'y', 'z'].map((c) => c.repeat(200)).join('/');
  mkdirSync(join(source, longDir), { recursive: true });
  for (let i = 100; i < 110; i++) writeFileSync(join(source, longDir + '/f-' + i), `long-${i}`);
  writeFileSync(join(source, 'executable.sh'), '#!/bin/sh\n');
  chmodSync(join(source, 'executable.sh'), 0o755);
  writeFileSync(join(source, 'target.txt'), 'target');
  symlinkSync('target.txt', join(source, 'link.txt'));
  symlinkSync('real-dir', join(source, 'dir-link'));
  symlinkSync('../target.txt', join(source, 'real-dir/child-link'));
  hostGit(source, ['add', '-A']);
  hostGit(source, ['update-index', '--add', '--cacheinfo', '160000,' + 'a'.repeat(40) + ',gitlink']);
  hostGit(source, ['commit', '-q', '-m', 'fixture']);
  const served = join(tempDir, 'served');
  mkdirSync(served);
  hostGit(tempDir, ['clone', '-q', '--bare', source, join(served, 'repo.git')]);
  hostGit(served, ['init', '-q', '--bare', '-b', 'main', 'empty.git']);
  server = startGitHttpServer(served, { plain: true });
  const repoUrl = server.url + '/repo.git';

  // Clones run through the real facet; fetches through a stub git bundle that
  // checks what the buffered fs shows it.
  writeFileSync(join(tempDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  writeFileSync(join(tempDir, 'git-bundle.js'), `
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
export const gitHttp = {};
export const git = {
  async fetch({ fs, dir }) {
    if (dir.replace(/^\\/+/, '') === 'mode') {
      await fs.promises.writeFile(dir + '/executable.sh', 'executable', { mode: 0o777 });
      const executable = await fs.promises.lstat(dir + '/executable.sh');
      assert((executable.mode & 0o777) === 0o755, 'pending fetch write lost executable mode');
      return;
    }
    const st = await fs.promises.stat(dir + '/existing.txt');
    const lst = await fs.promises.lstat(dir + '/existing-link');
    const names = await fs.promises.readdir(dir);
    assert(st.isFile() && st.size === 4, 'fetch stat did not fall through');
    assert(lst.isFile() && names.includes('existing.txt'), 'fetch metadata did not fall through');
  },
};
`);
  const facetWorker = await import(pathToFileURL(join(tempDir, 'git-network-worker.mjs')).href);

  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
  const wavePaths = [];
  let lease = null;
  const supervisor = {
    async stat(path) { return bridge.stat(path); },
    async lstat(path) { return bridge.stat(path, { followSymlinks: false }); },
    async hasLegacySymlinkUnder(path) { return getSymlinkRegistry(rawVfs).hasAtOrBelow(path); },
    async readdir(path) { return bridge.readdir(path); },
    async readFileBytes(path) { return bridge.readFile(path); },
    async fsReadRange(path, offset, length) { return bridge.readRange(path, offset, length); },
    async fsReadRangeUncached(path, offset, length) { return bridge.readRange(path, offset, length, { cached: false }); },
    async fsWriteRange(path, offset, bytes) { return bridge.writeRange(path, offset, bytes, { createParents: true, ...(lease ?? {}) }); },
    async fsTruncate(path, size) { return bridge.truncate(path, size, lease ?? {}); },
    async rename(from, to) { return bridge.rename(from, to, lease ?? {}); },
    async unlink(path) { return bridge.unlink(path); },
    async writeBatchStream(stream) {
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      wavePaths.push(await drainWave(byteStream(bytes.slice())));
      return vfs.writeStream(byteStream(bytes.slice()), lease ?? {});
    },
    async stdout() {},
  };

  /** A clone as the supervisor runs it (execGitNetwork), every phase through the facet. */
  const phasesSeen = [];
  async function clone(dir, url = repoUrl, extra = {}, phaseSupervisor = supervisor) {
    adoptCtxExports({ SupervisorRPC: () => phaseSupervisor });
    return execGitNetwork(
      { id: { toString: () => 'closed-world-do' } },
      {
        ASSETS: stagedAssets,
        LOADER: {
          load: () => ({
            getEntrypoint: () => ({
              async fetch(request) {
                phasesSeen.push((await request.clone().json()).phase);
                return facetWorker.default.fetch(request, { SUPERVISOR: phaseSupervisor });
              },
            }),
          }),
        },
      },
      { op: 'clone', pid: 1, dir, url, depth: 1, exclusiveDestination: true, ...extra },
    );
  }

  /** One facet phase, as execGitNetwork would send it. */
  async function phase(name, body, phaseSupervisor = supervisor) {
    const invocationId = name + '-' + crypto.randomUUID();
    const response = await facetWorker.default.fetch(
      new Request(`http://git/git/${name}/${invocationId}`, {
        method: 'POST',
        body: JSON.stringify({
          op: 'clone', url: repoUrl, exclusiveDestination: true, depth: 1,
          phase: name, invocationId, phaseDeadline: Date.now() + 30_000, ...body,
        }),
      }),
      { SUPERVISOR: phaseSupervisor },
    );
    return response.json();
  }

  // ── A clone ──
  {
    const result = await clone('/repo/./');
    assert.equal(result.success, true, result.error);
    assert.ok(wavePaths[0].includes('repo/.git/nimbus-clone-job'), 'the first clone wave did not durably establish ownership');
    assert.equal(vfs.exists('repo/.git/nimbus-clone-job'), false, 'the clone left its ownership marker');
    assert.ok(wavePaths.length > 3, 'the fixture crossed only ' + wavePaths.length + ' waves');
    assert.ok(wavePaths.every((paths) => paths.length <= W7_MAX_PATHS_PER_BATCH), 'a wave passed the owned-path limit');
    const pathBytes = (paths) => paths.reduce((bytes, path) => bytes + new TextEncoder().encode(path).byteLength, 0);
    assert.ok(wavePaths.every((paths) => pathBytes(paths) <= W7_MAX_OWNED_PATH_BYTES), 'a wave passed the owned-path-byte limit');
    assert.ok(wavePaths.some((paths) => paths.includes('repo/link.txt') && paths.includes('repo/real-dir/child-link') && paths.includes('repo/dir-link')),
      'symlinks were flushed one at a time instead of sharing a wave');
    assert.equal(vfs.readFileString('repo/src/file-0.txt'), 'file-0');
    assert.equal(vfs.readFileString('repo/src/file-259.txt'), 'file-259');
    assert.equal(vfs.readFileString('repo/' + longDir + '/f-109'), 'long-109');
    assert.equal(vfs.readFileString('repo/concurrent/file-179'), 'concurrent-179');
    assert.equal(vfs.stat('repo/executable.sh').mode & 0o777, 0o755);
    assert.equal(vfs.readlink('repo/link.txt'), 'target.txt');
    assert.equal(vfs.readlink('repo/dir-link'), 'real-dir');
    assert.equal(vfs.readlink('repo/real-dir/child-link'), '../target.txt');
    assert.equal((await bridge.stat('repo/link.txt', { followSymlinks: false })).type, 'symlink');
    assert.equal(vfs.stat('repo/gitlink').type, 'directory');
    assert.equal(vfs.readFileString('repo/.git/HEAD'), 'ref: refs/heads/main\n');
  }

  // ── An empty remote: HEAD and no worktree ──
  {
    const result = await clone('/unborn', server.url + '/empty.git');
    assert.equal(result.success, true, result.error);
    // Protocol v0 names no unborn branch: git takes its init default, as here.
    assert.equal(vfs.readFileString('unborn/.git/HEAD'), 'ref: refs/heads/master\n');
    assert.deepEqual(vfs.readdir('unborn').map((entry) => entry.name ?? entry), ['.git']);
  }

  // ── An existing empty root keeps its directory mode ──
  {
    vfs.mkdir('empty-vfs');
    const result = await clone('/empty-vfs');
    assert.equal(result.success, true, result.error);
    assert.equal(vfs.stat('empty-vfs').mode & 0o7777, 0o755, 'the existing root took file-type bits as its mode');
    assert.equal(vfs.readFileString('empty-vfs/src/file-1.txt'), 'file-1');
  }

  // ── Missing parents: created under the clone's lease, before anything below them ──
  {
    vfs.mkdir('workspace');
    const missingParentLease = rawVfs.acquireExclusiveMutation('/workspace/new/nested/repo', { includeMissingAncestors: true });
    assert.equal(missingParentLease.root, 'workspace/new');
    const first = wavePaths.length;
    lease = { mutationOwner: missingParentLease.owner };
    let result;
    try {
      result = await clone('/workspace/new/nested/repo', repoUrl, { exclusiveMutationRoot: 'workspace/new' });
    } finally {
      lease = null;
      rawVfs.releaseExclusiveMutation(missingParentLease.owner);
    }
    assert.equal(result.success, true, result.error);
    const parents = wavePaths.slice(first).findIndex((paths) =>
      paths.includes('workspace/new') && paths.includes('workspace/new/nested') && paths.includes('workspace/new/nested/repo'));
    const below = wavePaths.slice(first).findIndex((paths) => paths.some((path) => path.startsWith('workspace/new/nested/repo/')));
    assert.ok(parents >= 0 && parents < below, 'the clone wrote below its destination before the parents were durable');
    assert.equal(vfs.readFileString('workspace/new/nested/repo/src/file-259.txt'), 'file-259');
  }

  // ── Refused destinations: nothing written, no abort ──
  const refuse = async (dir, refusalSupervisor) => {
    phasesSeen.length = 0;
    const waves = wavePaths.length;
    const result = await clone(dir, repoUrl, {}, { stdout: async () => {}, ...refusalSupervisor });
    assert.equal(result.success, false, dir + ' was cloned into');
    assert.match(result.error, /destination path '.+' already exists and is not an empty directory/);
    assert.deepEqual(phasesSeen, ['clone-prepare'], dir + ': a refused destination ran ' + phasesSeen);
    assert.equal(wavePaths.length, waves, dir + ': a refused clone wrote');
    return result;
  };
  {
    const nonempty = await refuse('/occupied', {
      async lstat(path) { assert.equal(path, 'occupied'); return supervisorStat('directory'); },
      async readdir(path) { assert.equal(path, 'occupied'); return [{ name: 'keep.txt', type: 'file' }]; },
      async hasLegacySymlinkUnder() { return false; },
    });
    assert.equal(nonempty.supervisorRpc.lstat, 1);
    assert.equal(nonempty.supervisorRpc.readdir, 1);
    assert.equal(nonempty.supervisorRpc.writeBatchStream, 0);
    await refuse('/linked', {
      async lstat(path) { assert.equal(path, 'linked'); return supervisorStat('symlink', 6, 0o120777); },
    });
    await refuse('/linked-parent/repo', {
      async lstat(path) { assert.equal(path, 'linked-parent'); return supervisorStat('symlink', 6, 0o120777); },
    });
    for (const [dir, at] of [['/file-parent/repo', 'file-parent'], ['/file-destination', 'file-destination']]) {
      await refuse(dir, {
        async lstat(path) { assert.equal(path, at); return supervisorStat('file', 4); },
        async hasLegacySymlinkUnder() { return false; },
      });
    }
    const legacySymlinks = getSymlinkRegistry(rawVfs);
    legacySymlinks.set('orphan-root/injected', 'target.txt');
    await refuse('/orphan-root', supervisor);
    legacySymlinks.delete('orphan-root/injected');
    await bridge.mkdir('/existing-repo/.git', { recursive: true });
    const existingBytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
    await bridge.writeFile('/existing-repo/.git/sentinel', existingBytes);
    await refuse('/existing-repo', supervisor);
    assert.deepEqual(await bridge.readFile('/existing-repo/.git/sentinel'), existingBytes);
  }

  // ── Abort: only the clone whose marker names its job ──
  {
    const headBefore = await bridge.readFile('/repo/.git/HEAD');
    const unowned = { dir: '/repo', jobId: 'abort-job', optionsHash: 'b'.repeat(64) };
    for (let i = 0; i < 2; i++) {
      const abort = await phase('clone-abort', unowned);
      assert.equal(abort.success, true, abort.error);
      assert.equal(abort.refused, 'not-owner');
    }
    assert.deepEqual(await bridge.readFile('/repo/.git/HEAD'), headBefore, 'an unowned abort changed git metadata');
    assert.equal(vfs.readFileString('repo/src/file-259.txt'), 'file-259', 'an unowned abort removed the worktree');
    const foreign = new TextEncoder().encode(JSON.stringify({ version: 1, jobId: 'different-job', optionsHash: 'e'.repeat(64) }));
    await bridge.writeFile('/repo/.git/nimbus-clone-job', foreign);
    const mismatched = await phase('clone-abort', unowned);
    assert.equal(mismatched.refused, 'not-owner');
    assert.deepEqual(await bridge.readFile('/repo/.git/nimbus-clone-job'), foreign, 'abort changed another job\'s marker');
    await bridge.unlink('/repo/.git/nimbus-clone-job');

    const owned = { dir: '/owned-abort', jobId: 'owned-job', optionsHash: 'c'.repeat(64) };
    const prepared = await phase('clone-prepare', owned);
    assert.equal(prepared.success, true, prepared.error);
    assert.deepEqual(JSON.parse(vfs.readFileString('owned-abort/.git/nimbus-clone-job')), { version: 1, jobId: 'owned-job', optionsHash: 'c'.repeat(64) });
    assert.ok(vfs.exists('owned-abort/.git/objects/pack'), 'prepare stored its pack');
    const abort = await phase('clone-abort', owned);
    assert.equal(abort.success, true, abort.error);
    assert.equal(abort.refused, undefined);
    assert.equal(vfs.exists('owned-abort/.git'), false, 'an owned abort left git metadata');
  }

  // ── A phase past its deadline writes nothing ──
  {
    const expired = await phase('clone-prepare', { dir: '/expired', jobId: 'expired-job', optionsHash: 'd'.repeat(64), phaseDeadline: Date.now() - 1 });
    assert.equal(expired.success, false);
    assert.match(expired.error, /phase deadline/);
    assert.equal(vfs.exists('expired'), false, 'the facet wrote after its phase deadline');
  }

  // ── A fetch: stats and listings fall through below the repository; pending modes hold ──
  {
    vfs.mkdir('mode');
    const response = await facetWorker.default.fetch(
      new Request('http://git/op', { method: 'POST', body: JSON.stringify({ op: 'fetch', dir: '/mode' }) }),
      { SUPERVISOR: supervisor },
    );
    const mode = await response.json();
    assert.equal(mode.success, true, mode.error);
    assert.equal(vfs.stat('mode/executable.sh').mode & 0o777, 0o755);

    const raw = { stat: 0, readdir: 0 };
    const fallthrough = await facetWorker.default.fetch(
      new Request('http://git/op', { method: 'POST', body: JSON.stringify({ op: 'fetch', dir: '/existing' }) }),
      {
        SUPERVISOR: {
          async stat(path) {
            raw.stat++;
            if (path === 'existing/existing.txt' || path === 'existing/existing-link') return supervisorStat('file', 4);
            throw new Error('unexpected fetch stat: ' + path);
          },
          async lstat(path) {
            raw.stat++;
            if (path === 'existing/existing-link') return supervisorStat('file', 4);
            throw new Error('unexpected fetch lstat: ' + path);
          },
          async readdir(path) {
            raw.readdir++;
            assert.equal(path, 'existing');
            return [{ name: 'existing.txt', type: 'file' }];
          },
          async stdout() {},
        },
      },
    );
    const fallback = await fallthrough.json();
    assert.equal(fallback.success, true, fallback.error);
    assert.deepEqual(raw, { stat: 2, readdir: 1 });
  }
  console.log('git network facet closed-world adapter: ok');
} finally {
  server?.stop();
  rmSync(tempDir, { recursive: true, force: true });
}
