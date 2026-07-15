import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  decodeWriteBatchStream,
  W7_MAX_OWNED_PATH_BYTES,
  W7_MAX_PATHS_PER_BATCH,
} from '../../packages/worker/src/_shared/w7-frame.ts';
import { MAX_RPC_SAFE_PAYLOAD_BYTES } from '../../packages/worker/src/constants.ts';
import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { getSymlinkRegistry } from '../../packages/worker/src/vfs/symlink-registry.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const tempDir = mkdtempSync(join(tmpdir(), 'nimbus-git-facet-closed-world-'));

async function drainWave(stream) {
  const decoded = await decodeWriteBatchStream(stream);
  const paths = [];
  for await (const record of decoded.records) {
    if (record.type === 'directory' || record.type === 'file-begin') {
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

try {
  writeFileSync(join(tempDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  writeFileSync(join(tempDir, 'git-bundle.js'), `
const enc = new TextEncoder();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export const gitHttp = {};
export const git = {
  async clone({ fs, dir, cache, noCheckout }) {
    assert(noCheckout === true, 'clone prepare did not disable checkout');
    globalThis.__cloneCalls = (globalThis.__cloneCalls || 0) + 1;
    const root = dir.replace(/^\\/+/, '').split('/').filter(segment => segment && segment !== '.').join('/');
    if (root === 'workspace/new/nested/repo') {
      assert(globalThis.__nestedParentsDurable === true,
        'git clone started before leading destination directories were durable');
    }
    if (root === 'empty' || root === 'empty-vfs') {
      const existingRoot = await fs.promises.stat(dir);
      assert(existingRoot.isDirectory(), 'existing empty clone root was not seeded');
    }
    if (root === 'unborn') {
      await fs.promises.mkdir(root + '/.git');
      await fs.promises.writeFile(root + '/.git/HEAD', 'ref: refs/heads/main\\n');
      cache.prepared = true;
      return;
    }
    const packDir = root + '/.git/objects/pack';
    const packName = 'pack-' + '3'.repeat(40);
    const pack = packDir + '/' + packName + '.pack';
    const idx = packDir + '/' + packName + '.idx';

    await fs.promises.mkdir(packDir);
    await fs.promises.writeFile(pack, enc.encode('pack'));
    await fs.promises.writeFile(idx, enc.encode('idx'));
    await fs.promises.mkdir(root + '/.git/refs/heads');
    await fs.promises.writeFile(root + '/.git/HEAD', 'ref: refs/heads/main\\n');
    await fs.promises.writeFile(root + '/.git/refs/heads/main', '1'.repeat(40) + '\\n');

    const packNames = await fs.promises.readdir(packDir);
    assert(packNames.includes(packName + '.pack') && packNames.includes(packName + '.idx'),
      'local pack directory listing omitted a written object file');
    cache.prepared = true;
  },

  async resolveRef({ fs, dir }) {
    if (dir === '/empty' || dir === '/empty-vfs') return '1'.repeat(40);
    const head = (await fs.promises.readFile(dir + '/.git/HEAD', { encoding: 'utf8' })).trim();
    if (!head.startsWith('ref: ')) return head;
    return (await fs.promises.readFile(
      dir + '/.git/' + head.slice('ref: '.length),
      { encoding: 'utf8' },
    )).trim();
  },
  async readCommit({ fs, dir, cache }) {
    if (cache.prepared !== true) {
      const packName = 'pack-' + '3'.repeat(40) + '.pack';
      const pack = await fs.promises.readFile(dir + '/.git/objects/pack/' + packName);
      assert(pack.byteLength === globalThis.__coldPackSize,
        'cold checkout did not reconstruct the complete pack');
      assert(pack[0] === 7 && pack[pack.byteLength - 1] === 9,
        'cold checkout reconstructed different pack bytes');
      cache.prepared = true;
      globalThis.__coldPackReloaded = true;
    }
    return { commit: { tree: '2'.repeat(40) } };
  },
  async currentBranch({ fs, dir, test }) {
    if (dir === '/empty' || dir === '/empty-vfs') return 'refs/heads/main';
    const head = (await fs.promises.readFile(dir + '/.git/HEAD', { encoding: 'utf8' })).trim();
    if (!head.startsWith('ref: ')) return undefined;
    const ref = head.slice('ref: '.length);
    if (test) {
      try { await fs.promises.readFile(dir + '/.git/' + ref); }
      catch { return undefined; }
    }
    return ref;
  },

  async checkout({ fs, dir, cache }) {
    assert(cache.prepared === true, 'checkout did not reuse the prepared cache');
    const root = dir.replace(/^\\/+/, '').split('/').filter(segment => segment && segment !== '.').join('/');
    if (root === 'repo') {
      assert(globalThis.__prepareDurable === true,
        'checkout began before prepared .git state was durably flushed');
    }
    assert(root !== 'unborn', 'empty repository unexpectedly ran checkout');
    if (root === 'empty' || root === 'empty-vfs') {
      await fs.promises.writeFile(dir + '/created.txt', 'created');
      return;
    }
    const packDir = root + '/.git/objects/pack';

    for (let index = 0; index < 260; index++) {
      const oid = index.toString(16).padStart(40, '0');
      let missing = false;
      try {
        await fs.promises.readFile(root + '/.git/objects/' + oid.slice(0, 2) + '/' + oid.slice(2));
      } catch (error) {
        missing = error && error.code === 'ENOENT';
      }
      assert(missing, 'unknown loose object did not produce local ENOENT');
      const names = await fs.promises.readdir(packDir);
      assert(names.length === 2, 'pack directory listing drifted during checkout');

      const path = root + '/src/file-' + index + '.txt';
      await fs.promises.writeFile(path, enc.encode('file-' + index));
      if (index === 119) {
        await fs.promises.mkdir(root + '/src/generated/deep/tree');
      }
      const written = await fs.promises.lstat(path);
      assert(written.isFile() && !written.isSymbolicLink(), 'written file has the wrong kind');
      assert((written.mode & 0o777) === 0o644, 'written file has the wrong persisted mode');
      assert(written.size === enc.encode('file-' + index).byteLength, 'written file has the wrong size');
    }

    if (root === 'repo') {
      const longPrefix = 'x'.repeat(590);
      for (let index = 0; index < 110; index++) {
        await fs.promises.writeFile(
          root + '/long/' + longPrefix + '-' + index,
          enc.encode('long-' + index),
        );
      }
      await Promise.all(Array.from({ length: 180 }, (_, index) =>
        fs.promises.writeFile(root + '/concurrent/file-' + index, enc.encode('concurrent-' + index))));
    }

    const flushed = await fs.promises.readFile(root + '/src/file-0.txt', { encoding: 'utf8' });
    assert(flushed === 'file-0', 'flushed file did not read through persistent metadata');

    for (const method of ['stat', 'lstat']) {
      let unknown = false;
      try { await fs.promises[method](root + '/does-not-exist'); }
      catch (error) { unknown = error && error.code === 'ENOENT'; }
      assert(unknown, method + ' of an unknown authoritative path did not produce local ENOENT');
    }

    await fs.promises.mkdir(root + '/empty-dir');
    await fs.promises.writeFile(root + '/target.txt', 'target');
    await fs.promises.mkdir(root + '/real-dir');
    await fs.promises.writeFile(root + '/real-dir/child.txt', 'child');
    await fs.promises.writeFile(root + '/executable.sh', '#!/bin/sh\\n', { mode: 0o777 });
    await fs.promises.symlink('target.txt', root + '/link.txt');
    await fs.promises.symlink('../target.txt', root + '/real-dir/child-link');
    await fs.promises.symlink('real-dir', root + '/dir-link');
    await fs.promises.mkdir(root + '/gitlink');
    const link = await fs.promises.lstat(root + '/link.txt');
    if (root === 'repo') {
      assert(globalThis.__symlinkBatchDurable === true,
        'lstat reported a symlink before its shared wave became durable');
    }
    assert(link.isSymbolicLink() && !link.isFile() && link.mode === 0o120777,
      'lstat did not report the symlink itself');
    const followed = await fs.promises.stat(root + '/link.txt');
    assert(followed.isFile() && followed.size === 6, 'stat did not follow the local symlink');
    assert(await fs.promises.readlink(root + '/link.txt') === 'target.txt', 'readlink target changed');
    const linkedDirNames = await fs.promises.readdir(root + '/dir-link');
    assert(linkedDirNames.includes('child.txt'), 'readdir did not follow a local directory symlink');
    const linkedChild = await fs.promises.lstat(root + '/dir-link/child.txt');
    assert(linkedChild.isFile(), 'lstat did not follow a symlink in a parent component');
    assert(await fs.promises.readlink(root + '/dir-link/child-link') === '../target.txt',
      'readlink did not follow a symlink in a parent component');

    for (const [path, expectedCode] of [
      [root + '/does-not-exist', 'ENOENT'],
      [root + '/target.txt', 'ENOTDIR'],
      [root + '/target.txt/child', 'ENOTDIR'],
    ]) {
      let code = null;
      try { await fs.promises.readdir(path); }
      catch (error) { code = error && error.code; }
      assert(code === expectedCode, 'readdir ' + path + ' returned ' + code + ', expected ' + expectedCode);
    }

    for (const method of ['stat', 'lstat', 'readlink']) {
      let code = null;
      try { await fs.promises[method](root + '/target.txt/child'); }
      catch (error) { code = error && error.code; }
      assert(code === 'ENOTDIR', method + ' through a regular file returned ' + code);
    }

    const rootNames = await fs.promises.readdir(root);
    assert(rootNames.includes('.git') && rootNames.includes('src') && rootNames.includes('empty-dir'),
      'authoritative root listing omitted overlay children');
    assert(!rootNames.includes('does-not-exist'), 'authoritative root listing invented a child');

    const outside = await fs.promises.stat('/outside/existing.txt');
    assert(outside.isFile() && outside.size === 9, 'path outside clone root did not fall through');
  },

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
  let cloneJobSequence = 0;
  let lastPrepared = null;
  const worker = {
    default: {
      async fetch(request, env) {
        const body = await request.clone().json();
        if (body.op !== 'clone' || body.phase) {
          return facetWorker.default.fetch(request, env);
        }
        const jobId = `closed-world-${++cloneJobSequence}`;
        const optionsHash = 'a'.repeat(64);
        const prepareInvocationId = `${jobId}-prepare`;
        const prepareResponse = await facetWorker.default.fetch(
          new Request(`http://git/git/clone-prepare/${prepareInvocationId}`, {
            method: 'POST',
            body: JSON.stringify({
              ...body,
              phase: 'clone-prepare',
              invocationId: prepareInvocationId,
              jobId,
              optionsHash,
            }),
          }),
          env,
        );
        const prepare = await prepareResponse.json();
        if (!prepare.success) return Response.json(prepare);
        lastPrepared = structuredClone(prepare.prepared);
        const checkoutInvocationId = `${jobId}-checkout`;
        const checkoutResponse = await facetWorker.default.fetch(
          new Request(`http://git/git/clone-checkout/${checkoutInvocationId}`, {
            method: 'POST',
            body: JSON.stringify({
              ...body,
              phase: 'clone-checkout',
              invocationId: checkoutInvocationId,
              jobId,
              optionsHash,
              prepared: prepare.prepared,
            }),
          }),
          env,
        );
        const checkout = await checkoutResponse.json();
        const supervisorRpc = {};
        for (const key of Object.keys(prepare.supervisorRpc)) {
          supervisorRpc[key] = prepare.supervisorRpc[key] + checkout.supervisorRpc[key];
        }
        return Response.json({
          ...checkout,
          filesWritten: prepare.filesWritten + checkout.filesWritten,
          bytesWritten: prepare.bytesWritten + checkout.bytesWritten,
          supervisorRpc,
        });
      },
    },
  };

  const rawCalls = {
    stat: [],
    lstat: [],
    readdir: [],
    readFile: 0,
    fsReadRange: 0,
    writeBatchStream: 0,
    legacySymlinkSubtree: 0,
    stdout: 0,
  };
  const wavePaths = [];
  globalThis.__symlinkBatchDurable = false;
  globalThis.__nestedParentsDurable = false;
  globalThis.__prepareDurable = false;
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const bridge = new SqliteRuntimeFsBridge(vfs);
  await bridge.writeFile('/outside/existing.txt', 'outside!!');
  const supervisor = {
    async stat(path) {
      rawCalls.stat.push(path);
      return bridge.stat(path);
    },
    async lstat(path) {
      rawCalls.lstat.push(path);
      return bridge.stat(path, { followSymlinks: false });
    },
    async hasLegacySymlinkUnder(path) {
      rawCalls.legacySymlinkSubtree++;
      return getSymlinkRegistry(vfs).hasAtOrBelow(path);
    },
    async readdir(path) {
      rawCalls.readdir.push(path);
      return bridge.readdir(path);
    },
    async readFileBytes(path) {
      rawCalls.readFile++;
      return bridge.readFile(path);
    },
    async fsReadRange() {
      rawCalls.fsReadRange++;
      throw new Error('authoritative loose-object miss reached fsReadRange');
    },
    async writeBatchStream(stream) {
      rawCalls.writeBatchStream++;
      const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
      const paths = await drainWave(byteStream(bytes.slice()));
      const result = await vfs.writeStream(byteStream(bytes.slice()));
      wavePaths.push(paths);
      if (result.ok === true &&
          vfs.exists('repo/.git/HEAD') &&
          vfs.exists('repo/.git/refs/heads/main') &&
          vfs.exists('repo/.git/objects/pack/pack-' + '3'.repeat(40) + '.pack') &&
          vfs.exists('repo/.git/objects/pack/pack-' + '3'.repeat(40) + '.idx')) {
        globalThis.__prepareDurable = true;
      }
      if (paths.includes('repo/link.txt') &&
          paths.includes('repo/real-dir/child-link') &&
          paths.includes('repo/dir-link')) {
        globalThis.__symlinkBatchDurable = result.ok === true;
      }
      return result;
    },
    async stdout() { rawCalls.stdout++; },
  };

  const response = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/repo/./',
        url: 'https://example.invalid/repo.git',
        exclusiveDestination: true,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const result = await response.json();
  assert.equal(result.success, true, result.error);
  assert.equal(rawCalls.stat.filter((path) => path.includes('/.git/objects/')).length, 0);
  assert.equal(rawCalls.readdir.filter((path) => path.endsWith('/.git/objects/pack')).length, 0);
  assert.equal(result.supervisorRpc.stat, 1, 'only outside-root stat should cross');
  assert.equal(result.supervisorRpc.lstat, 1, 'only destination proof should cross');
  assert.equal(result.supervisorRpc.readdir, 0, 'absent destination and pack listings must stay local');
  assert.equal(result.supervisorRpc.readFile, 4,
    'checkout should read durable HEAD/ref identity plus the explicit outside-root fixture');
  assert.equal(result.supervisorRpc.fsReadRange, 0);
  assert.equal(result.supervisorRpc.writeBatchStream, rawCalls.writeBatchStream);
  assert.equal(result.supervisorRpc.legacySymlinkSubtree, 1);
  assert.ok(rawCalls.writeBatchStream > 1, 'fixture did not cross multiple W7 waves');
  assert.ok(rawCalls.writeBatchStream < 20, 'write RPCs grew with file count instead of waves');
  assert.ok(
    wavePaths.every((paths) => paths.length <= W7_MAX_PATHS_PER_BATCH),
    'checkout emitted a W7 wave above the encoder owned-path limit',
  );
  const pathEncoder = new TextEncoder();
  assert.ok(
    wavePaths.every((paths) =>
      paths.reduce((bytes, path) => bytes + pathEncoder.encode(path).byteLength, 0) <=
        W7_MAX_OWNED_PATH_BYTES),
    'checkout emitted a W7 wave above the encoder owned-path-byte limit',
  );
  assert.ok(
    wavePaths.some((paths) =>
      paths.includes('repo/link.txt') &&
      paths.includes('repo/real-dir/child-link') &&
      paths.includes('repo/dir-link')),
    'symlinks were flushed one-at-a-time instead of sharing a wave',
  );
  assert.equal(vfs.readFileString('repo/src/file-0.txt'), 'file-0');
  assert.equal(vfs.readFileString('repo/src/file-259.txt'), 'file-259');
  assert.equal(
    vfs.readFileString('repo/long/' + 'x'.repeat(590) + '-109'),
    'long-109',
  );
  assert.equal(vfs.readFileString('repo/concurrent/file-179'), 'concurrent-179');
  assert.equal(vfs.stat('repo/executable.sh').mode, 0o755);
  assert.equal(vfs.stat('repo/link.txt').type, 'symlink');
  assert.equal(vfs.readlink('repo/link.txt'), 'target.txt');
  assert.equal(vfs.stat('repo/dir-link').type, 'symlink');
  assert.equal(vfs.readlink('repo/dir-link'), 'real-dir');
  assert.equal((await bridge.stat('repo/link.txt', { followSymlinks: false })).type, 'symlink');
  assert.equal(vfs.stat('repo/gitlink').type, 'directory');

  const warmOutput = vfs.readFileString('repo/src/file-259.txt');
  const coldPrepared = structuredClone(lastPrepared);
  const coldPackSize = MAX_RPC_SAFE_PAYLOAD_BYTES + 1;
  const coldPack = coldPrepared.packs[0];
  coldPack.packBytes = coldPackSize;
  const coldPackMetadata = coldPrepared.metadata.find(([path]) => path === coldPack.packPath);
  assert.ok(coldPackMetadata, 'prepare result omitted pack metadata');
  coldPackMetadata[1].size = coldPackSize;
  globalThis.__coldPackSize = coldPackSize;
  globalThis.__coldPackReloaded = false;
  writeFileSync(join(tempDir, 'git-network-worker-cold.mjs'), assembleGitNetworkFacetSource());
  const coldWorker = await import(
    pathToFileURL(join(tempDir, 'git-network-worker-cold.mjs')).href
  );
  const coldRanges = [];
  const coldResponse = await coldWorker.default.fetch(
    new Request('http://git/git/clone-checkout/cold-cache-checkout', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/repo',
        url: 'https://example.invalid/repo.git',
        exclusiveDestination: true,
        phase: 'clone-checkout',
        invocationId: 'cold-cache-checkout',
        jobId: coldPrepared.jobId,
        optionsHash: coldPrepared.optionsHash,
        prepared: coldPrepared,
      }),
    }),
    {
      SUPERVISOR: {
        ...supervisor,
        async fsReadRange(path, offset, length) {
          assert.equal(path, coldPack.packPath);
          coldRanges.push({ offset, length });
          const bytes = new Uint8Array(length);
          bytes.fill(5);
          if (offset === 0) bytes[0] = 7;
          if (offset + length === coldPackSize) bytes[bytes.length - 1] = 9;
          return bytes;
        },
      },
    },
  );
  const cold = await coldResponse.json();
  assert.equal(cold.success, true, cold.error);
  assert.equal(globalThis.__coldPackReloaded, true, 'cold checkout incorrectly required job cache');
  assert.ok(coldRanges.length > 1, 'cold pack reload did not use bounded range reads');
  assert.ok(coldRanges.every(({ length }) => length <= 4 * 1024 * 1024));
  assert.equal(cold.supervisorRpc.fsReadRange, coldRanges.length);
  assert.equal(vfs.readFileString('repo/src/file-259.txt'), warmOutput,
    'cold-cache checkout output differs from warm-cache checkout');

  const unbornResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/unborn',
        url: 'https://example.invalid/empty.git',
        exclusiveDestination: true,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const unborn = await unbornResponse.json();
  assert.equal(unborn.success, true, unborn.error);
  assert.equal(vfs.readFileString('unborn/.git/HEAD'), 'ref: refs/heads/main\n');
  assert.equal(vfs.exists('unborn/src'), false, 'empty repository materialized a worktree');

  vfs.mkdir('empty-vfs');
  const existingEmptyResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/empty-vfs',
        url: 'https://example.invalid/repo.git',
        exclusiveDestination: true,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const existingEmpty = await existingEmptyResponse.json();
  assert.equal(existingEmpty.success, true, existingEmpty.error);
  assert.equal(vfs.stat('empty-vfs').mode, 0o755, 'existing root persisted file-type bits as mode');

  const emptyWaves = [];
  const emptyResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/empty',
        url: 'https://example.invalid/repo.git',
        exclusiveDestination: true,
      }),
    }),
    {
      SUPERVISOR: {
        async lstat(path) {
          assert.equal(path, 'empty');
          return supervisorStat('directory');
        },
        async readdir(path) {
          assert.equal(path, 'empty');
          return [];
        },
        async hasLegacySymlinkUnder() { return false; },
        async writeBatchStream(stream) {
          const paths = await drainWave(stream);
          emptyWaves.push(paths);
          return {
            ok: true,
            committedGroupSequence: paths.length,
            committedPathCount: paths.length,
            inodes: paths.length,
            chunks: 0,
          };
        },
        async stdout() {},
      },
    },
  );
  const empty = await emptyResponse.json();
  assert.equal(empty.success, true, empty.error);
  assert.equal(empty.supervisorRpc.lstat, 1);
  assert.equal(empty.supervisorRpc.readdir, 1);
  assert.ok(emptyWaves.flat().includes('empty/created.txt'));

  globalThis.__cloneCalls = 0;
  const nonemptyResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'clone', dir: '/occupied', url: 'https://example.invalid/repo.git' }),
    }),
    {
      SUPERVISOR: {
        async lstat(path) {
          assert.equal(path, 'occupied');
          return supervisorStat('directory');
        },
        async readdir(path) {
          assert.equal(path, 'occupied');
          return [{ name: 'keep.txt', type: 'file' }];
        },
        async hasLegacySymlinkUnder() { return false; },
        async stdout() {},
      },
    },
  );
  const nonempty = await nonemptyResponse.json();
  assert.equal(nonempty.success, false);
  assert.match(nonempty.error, /destination path '.+' already exists and is not an empty directory/);
  assert.equal(globalThis.__cloneCalls, 0, 'cf-git ran against a nonempty clone destination');
  assert.deepEqual(nonempty.supervisorRpc, {
    stat: 0,
    lstat: 1,
    readdir: 1,
    readFile: 0,
    fsReadRange: 0,
    writeBatchStream: 0,
    readlink: 0,
    symlink: 0,
    legacySymlinkSubtree: 1,
    stdout: 0,
  });

  const symlinkDestinationResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'clone', dir: '/linked', url: 'https://example.invalid/repo.git' }),
    }),
    {
      SUPERVISOR: {
        async lstat(path) {
          assert.equal(path, 'linked');
          return supervisorStat('symlink', 6, 0o120777);
        },
        async stdout() {},
      },
    },
  );
  const symlinkDestination = await symlinkDestinationResponse.json();
  assert.equal(symlinkDestination.success, false);
  assert.match(symlinkDestination.error, /already exists and is not an empty directory/);

  const cloneCallsBeforeMissingParent = globalThis.__cloneCalls;
  vfs.mkdir('workspace');
  const missingParentLease = vfs.acquireExclusiveMutation('/workspace/new/nested/repo', {
    includeMissingAncestors: true,
  });
  assert.equal(missingParentLease.root, 'workspace/new');
  let missingParentResponse;
  try {
    missingParentResponse = await worker.default.fetch(
      new Request('http://git/op', {
        method: 'POST',
        body: JSON.stringify({
          op: 'clone',
          dir: '/workspace/new/nested/repo',
          url: 'https://example.invalid/repo.git',
          exclusiveDestination: true,
          exclusiveMutationRoot: 'workspace/new',
        }),
      }),
      {
        SUPERVISOR: {
          ...supervisor,
          async writeBatchStream(stream) {
            const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
            const paths = await drainWave(byteStream(bytes.slice()));
            const result = await vfs.writeStream(byteStream(bytes.slice()), {
              mutationOwner: missingParentLease.owner,
            });
            if (paths.includes('workspace/new') &&
                paths.includes('workspace/new/nested') &&
                paths.includes('workspace/new/nested/repo')) {
              globalThis.__nestedParentsDurable = result.ok === true;
            }
            return result;
          },
        },
      },
    );
  } finally {
    vfs.releaseExclusiveMutation(missingParentLease.owner);
  }
  const missingParent = await missingParentResponse.json();
  assert.equal(missingParent.success, true, missingParent.error);
  assert.equal(globalThis.__cloneCalls, cloneCallsBeforeMissingParent + 1);
  assert.equal(vfs.isDirectory('workspace'), true);
  assert.equal(vfs.isDirectory('workspace/new'), true);
  assert.equal(vfs.isDirectory('workspace/new/nested'), true);
  assert.equal(vfs.isDirectory('workspace/new/nested/repo'), true);
  assert.equal(vfs.readFileString('workspace/new/nested/repo/src/file-259.txt'), 'file-259');

  const symlinkAncestorResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/linked-parent/repo',
        url: 'https://example.invalid/repo.git',
        exclusiveDestination: true,
      }),
    }),
    {
      SUPERVISOR: {
        async lstat(path) {
          assert.equal(path, 'linked-parent');
          return supervisorStat('symlink', 6, 0o120777);
        },
        async stdout() {},
      },
    },
  );
  const symlinkAncestor = await symlinkAncestorResponse.json();
  assert.equal(symlinkAncestor.success, false);
  assert.match(symlinkAncestor.error, /already exists and is not an empty directory/);

  for (const [dir, ancestor] of [
    ['/file-parent/repo', true],
    ['/file-destination', false],
  ]) {
    const fileConflictResponse = await worker.default.fetch(
      new Request('http://git/op', {
        method: 'POST',
        body: JSON.stringify({ op: 'clone', dir, url: 'https://example.invalid/repo.git' }),
      }),
      {
        SUPERVISOR: {
          async lstat(path) {
            if (ancestor) assert.equal(path, 'file-parent');
            else assert.equal(path, 'file-destination');
            return supervisorStat('file', 4);
          },
          async hasLegacySymlinkUnder() { return false; },
          async stdout() {},
        },
      },
    );
    const fileConflict = await fileConflictResponse.json();
    assert.equal(fileConflict.success, false);
    assert.match(fileConflict.error, /already exists and is not an empty directory/);
  }

  const legacySymlinks = getSymlinkRegistry(vfs);
  legacySymlinks.set('orphan-root/injected', 'target.txt');
  const cloneCallsBeforeOrphan = globalThis.__cloneCalls;
  const orphanResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/orphan-root',
        url: 'https://example.invalid/repo.git',
        exclusiveDestination: true,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const orphan = await orphanResponse.json();
  assert.equal(orphan.success, false);
  assert.match(orphan.error, /already exists and is not an empty directory/);
  assert.equal(globalThis.__cloneCalls, cloneCallsBeforeOrphan);
  legacySymlinks.delete('orphan-root/injected');

  const modeResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'fetch', dir: '/mode' }),
    }),
    { SUPERVISOR: supervisor },
  );
  const modeResult = await modeResponse.json();
  assert.equal(modeResult.success, true, modeResult.error);
  assert.equal(vfs.stat('mode/executable.sh').mode, 0o755);

  const fallbackRaw = { stat: 0, readdir: 0 };
  const fetchResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'fetch', dir: '/existing' }),
    }),
    {
      SUPERVISOR: {
        async stat(path) {
          fallbackRaw.stat++;
          if (path === 'existing/existing.txt') return supervisorStat('file', 4);
          if (path === 'existing/existing-link') return supervisorStat('file', 4);
          throw new Error('unexpected fetch stat: ' + path);
        },
        async lstat(path) {
          fallbackRaw.stat++;
          if (path === 'existing/existing-link') return supervisorStat('file', 4);
          throw new Error('unexpected fetch lstat: ' + path);
        },
        async readdir(path) {
          fallbackRaw.readdir++;
          assert.equal(path, 'existing');
          return [{ name: 'existing.txt', type: 'file' }];
        },
        async stdout() {},
      },
    },
  );
  const fallback = await fetchResponse.json();
  assert.equal(fallback.success, true, fallback.error);
  assert.deepEqual(fallbackRaw, { stat: 2, readdir: 1 });
  assert.equal(fallback.supervisorRpc.stat, 1);
  assert.equal(fallback.supervisorRpc.lstat, 1);
  assert.equal(fallback.supervisorRpc.readdir, 1);

  const abortResponse = await coldWorker.default.fetch(
    new Request('http://git/git/clone-abort/abort-invocation', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/repo',
        phase: 'clone-abort',
        invocationId: 'abort-invocation',
        jobId: 'abort-job',
        optionsHash: 'b'.repeat(64),
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const abort = await abortResponse.json();
  assert.equal(abort.success, true, abort.error);
  assert.equal(vfs.exists('repo/.git'), false, 'abort left partial Git metadata behind');
  assert.equal(vfs.readFileString('repo/src/file-259.txt'), warmOutput,
    'abort removed the committed worktree prefix');
  const repeatedAbortResponse = await coldWorker.default.fetch(
    new Request('http://git/git/clone-abort/abort-invocation-repeat', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/repo',
        phase: 'clone-abort',
        invocationId: 'abort-invocation-repeat',
        jobId: 'abort-job',
        optionsHash: 'b'.repeat(64),
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const repeatedAbort = await repeatedAbortResponse.json();
  assert.equal(repeatedAbort.success, true, repeatedAbort.error);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('git network facet closed-world adapter: ok');
