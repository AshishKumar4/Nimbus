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
import {
  assembleGitNetworkFacetSource,
  execGitNetwork,
} from '../../packages/worker/src/git/network-facet.ts';
import { SqliteRuntimeFsBridge } from '../../packages/worker/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
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

  async checkoutFreshChunk({
    fs,
    dir,
    cache,
    cursor,
    maxEntries,
    maxDecodedBytes,
    maxWallMs,
    deferIndexFragmentCleanup,
    onProgress,
  }) {
    assert(cache.prepared === true, 'checkout did not reuse the prepared cache');
    assert(maxEntries > 0 && maxDecodedBytes > 0 && maxWallMs > 0,
      'checkout bounds were not forwarded');
    assert(deferIndexFragmentCleanup === true,
      'facet did not retain fragments through terminal marker acknowledgement');
    const root = dir.replace(/^\\/+/, '').split('/').filter(segment => segment && segment !== '.').join('/');
    if (root === 'repo') {
      assert(globalThis.__prepareDurable === true,
        'checkout began before prepared .git state was durably flushed');
    }
    assert(root !== 'unborn', 'empty repository unexpectedly ran checkout');
    if (root === 'continuation' || root === 'marker-replay' ||
        root === 'terminal-replay' || root.startsWith('chunk-failure-')) {
      if (cursor === null) {
        await fs.promises.mkdir(root + '/.git/nimbus-checkout-index');
        await fs.promises.writeFile(
          root + '/.git/nimbus-checkout-index/00000000',
          'fragment',
        );
        await fs.promises.writeFile(root + '/first.txt', 'first');
        return {
          nextCursor: {
            version: 2,
            tree: '2'.repeat(40),
            stack: [{ treeOid: '2'.repeat(40), path: '', nextChildIndex: 1 }],
            directories: [],
            indexChunks: 1,
            indexEntries: 1,
          },
          files: 1,
          decodedBytes: 5,
          treeEntriesVisited: 1,
          indexEntries: 1,
        };
      }
      assert(cursor.stack[0].nextChildIndex === 1, 'continuation cursor changed');
      if (root === 'continuation') {
        assert(globalThis.__continuationFirstDurable === true,
          'next chunk started before the prior chunk was durable');
      }
      await fs.promises.writeFile(root + '/second.txt', 'second');
      return {
        nextCursor: null,
        files: 1,
        decodedBytes: 6,
        treeEntriesVisited: 1,
        indexEntries: 2,
      };
    }
    assert(cursor === null, 'closed-world fixture received an unexpected continuation');
    if (root === 'progress') {
      const originalNow = Date.now;
      const startedAt = originalNow();
      try {
        await onProgress({ phase: 'Updating workdir', loaded: 1, total: 3 });
        Date.now = () => startedAt + 2001;
        await onProgress({ phase: 'Updating workdir', loaded: 2, total: 3 });
      } finally {
        Date.now = originalNow;
      }
      return {
        nextCursor: null, files: 0, decodedBytes: 0,
        treeEntriesVisited: 0, indexEntries: 0,
      };
    }
    if (root === 'empty' || root === 'empty-vfs') {
      await fs.promises.writeFile(dir + '/created.txt', 'created');
      return {
        nextCursor: null, files: 1, decodedBytes: 7,
        treeEntriesVisited: 1, indexEntries: 1,
      };
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
    return {
      nextCursor: null,
      files: 554,
      decodedBytes: 4096,
      treeEntriesVisited: 560,
      indexEntries: 554,
    };
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
              phaseDeadline: Date.now() + 30_000,
            }),
          }),
          env,
        );
        const prepare = await prepareResponse.json();
        if (!prepare.success) return Response.json(prepare);
        lastPrepared = structuredClone(prepare.prepared);
        const cloneRoot = body.dir.split('/').filter(segment => segment && segment !== '.').join('/');
        if (cloneRoot === 'repo') {
          assert(vfs.exists(cloneRoot + '/.git/nimbus-clone-job'),
            'prepare response became visible without its durable ownership marker');
        }
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
              checkoutCursor: null,
              checkoutBounds: {
                maxEntries: 10_000,
                maxDecodedBytes: 32 * 1024 * 1024,
                maxWallMs: 20_000,
              },
              phaseDeadline: Date.now() + 30_000,
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
  const continuationMarkerWaves = [];
  const continuationMarkerContentIds = new Set();
  globalThis.__symlinkBatchDurable = false;
  globalThis.__nestedParentsDurable = false;
  globalThis.__prepareDurable = false;
  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const bridge = new SqliteRuntimeFsBridge(rawVfs);
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
      return getSymlinkRegistry(rawVfs).hasAtOrBelow(path);
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
      if (paths.includes('continuation/first.txt')) {
        globalThis.__continuationFirstDurable = result.ok === true;
      }
      if (result.ok === true && paths.includes('continuation/.git/nimbus-clone-job')) {
        continuationMarkerWaves.push({
          paths,
          marker: vfs.exists('continuation/.git/nimbus-clone-job')
            ? JSON.parse(vfs.readFileString('continuation/.git/nimbus-clone-job'))
            : null,
        });
      }
      if (result.ok === true) {
        for (const row of harness.sql.exec(
          "SELECT content_id FROM inodes WHERE path = 'continuation/.git/nimbus-clone-job'",
        )) {
          continuationMarkerContentIds.add(String(row.content_id));
        }
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
  assert.equal(vfs.exists('repo/.git/nimbus-clone-job'), false,
    'successful checkout shipped the internal clone ownership marker');
  assert.ok(wavePaths[0].includes('repo/.git/nimbus-clone-job'),
    'the first clone wave did not durably establish ownership');
  assert.equal(rawCalls.stat.filter((path) => path.includes('/.git/objects/')).length, 0);
  assert.equal(rawCalls.readdir.filter((path) => path.endsWith('/.git/objects/pack')).length, 0);
  assert.equal(result.supervisorRpc.stat, 1, 'only outside-root stat should cross');
  assert.equal(result.supervisorRpc.lstat, 1, 'only destination proof should cross');
  assert.equal(result.supervisorRpc.readdir, 0, 'absent destination and pack listings must stay local');
  assert.equal(result.supervisorRpc.readFile, 5,
    'checkout should read durable ownership/HEAD/ref identity plus the outside-root fixture');
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
  await bridge.writeFile(
    '/repo/.git/nimbus-clone-job',
    JSON.stringify({
      version: 1,
      jobId: coldPrepared.jobId,
      optionsHash: coldPrepared.optionsHash,
    }),
  );
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
        checkoutCursor: null,
        checkoutBounds: {
          maxEntries: 10_000,
          maxDecodedBytes: 32 * 1024 * 1024,
          maxWallMs: 20_000,
        },
        phaseDeadline: Date.now() + 30_000,
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
        ...supervisor,
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
          const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
          const paths = await drainWave(byteStream(bytes.slice()));
          emptyWaves.push(paths);
          return vfs.writeStream(byteStream(bytes.slice()));
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
  const missingParentLease = rawVfs.acquireExclusiveMutation('/workspace/new/nested/repo', {
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
    rawVfs.releaseExclusiveMutation(missingParentLease.owner);
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

  const legacySymlinks = getSymlinkRegistry(rawVfs);
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

  const runChunkedClone = async (dir, chunkSupervisor) => {
    setCtxExports({ SupervisorRPC: () => chunkSupervisor });
    return execGitNetwork(
      { id: { toString: () => 'closed-world-chunk-do' } },
      {
        LOADER: {
          load() {
            return {
              getEntrypoint() {
                return {
                  fetch(request) {
                    return facetWorker.default.fetch(request, { SUPERVISOR: chunkSupervisor });
                  },
                };
              },
            };
          },
        },
      },
      {
        op: 'clone',
        dir: `/${dir}`,
        url: 'https://example.invalid/repo.git',
        exclusiveDestination: true,
        exclusiveMutationRoot: dir,
        mutationOwner: 'owner',
      },
    );
  };

  const continued = await runChunkedClone('continuation', supervisor);
  assert.equal(continued.success, true, continued.error);
  assert.deepEqual(
    continued.phases.map(phase => phase.phase),
    ['clone-prepare', 'clone-checkout', 'clone-checkout'],
  );
  assert.equal(vfs.readFileString('continuation/first.txt'), 'first');
  assert.equal(vfs.readFileString('continuation/second.txt'), 'second');
  assert.equal(vfs.exists('continuation/.git/nimbus-clone-job'), false,
    'final chunk left the ownership marker behind');
  const firstCursor = {
    version: 2,
    tree: '2'.repeat(40),
    stack: [{ treeOid: '2'.repeat(40), path: '', nextChildIndex: 1 }],
    directories: [],
    indexChunks: 1,
    indexEntries: 1,
  };
  // The pin asserts marker presence: content waves must not re-write the
  // unchanged marker (each re-write schedules content GC on the receiver).
  assert.ok(
    wavePaths.some((paths) => paths.includes('continuation/first.txt')),
    'first chunk did not flush a worktree/index wave',
  );
  assert.ok(
    continuationMarkerWaves.every(({ paths }) =>
      !paths.some(path => path.endsWith('.txt') || path.endsWith('/index'))),
    'a checkout content wave re-wrote the unchanged ownership marker',
  );
  assert.ok(
    continuationMarkerWaves.some(({ paths, marker }) =>
      marker && marker.cursorSeq === 1 &&
      !paths.some(path => path.endsWith('.txt') || path.endsWith('/index')) &&
      JSON.stringify(marker.cursor) === JSON.stringify(firstCursor)),
    'first committed cursor was not advanced in a final marker-only wave',
  );
  // Marker generations that legitimately schedule GC: v1 → prepared-seq0
  // overwrite, seq0 → committed-seq1 overwrite, and the terminal delete.
  // Every additional scheduling is an unchanged-marker re-write re-arming
  // content maintenance once per wave.
  const markerGcSchedules = harness.statements.filter((statement) =>
    /INSERT (OR IGNORE )?INTO content_lifecycle/.test(statement.sql) &&
    statement.sql.includes("'gc'") &&
    statement.params.some((param) => continuationMarkerContentIds.has(String(param))));
  assert.equal(markerGcSchedules.length, 3,
    'unchanged marker waves scheduled content GC');

  const replayJobId = 'marker-replay-job';
  const replayOptionsHash = 'f'.repeat(64);
  const replayPhase = async (phase, invocationId, body) => {
    const response = await facetWorker.default.fetch(
      new Request(`http://git/git/${phase}/${invocationId}`, {
        method: 'POST',
        body: JSON.stringify({
          op: 'clone',
          dir: '/marker-replay',
          url: 'https://example.invalid/repo.git',
          exclusiveDestination: true,
          phase,
          invocationId,
          jobId: replayJobId,
          optionsHash: replayOptionsHash,
          phaseDeadline: Date.now() + 30_000,
          ...body,
        }),
      }),
      { SUPERVISOR: supervisor },
    );
    return response.json();
  };
  const replayPrepare = await replayPhase('clone-prepare', 'marker-replay-prepare', {});
  assert.equal(replayPrepare.success, true, replayPrepare.error);
  const replayChunkBody = {
    prepared: replayPrepare.prepared,
    checkoutCursor: null,
    checkoutBounds: {
      maxEntries: 10_000,
      maxDecodedBytes: 32 * 1024 * 1024,
      maxWallMs: 20_000,
    },
  };
  const replayFirst = await replayPhase(
    'clone-checkout',
    'marker-replay-first',
    replayChunkBody,
  );
  assert.equal(replayFirst.success, true, replayFirst.error);
  assert.deepEqual(
    JSON.parse(vfs.readFileString('marker-replay/.git/nimbus-clone-job')),
    {
      version: 2,
      jobId: replayJobId,
      optionsHash: replayOptionsHash,
      prepared: {
        commit: '1'.repeat(40),
        tree: '2'.repeat(40),
        headRef: 'refs/heads/main',
      },
      cursor: firstCursor,
      cursorSeq: 1,
    },
  );
  const replayOldCursor = await replayPhase(
    'clone-checkout',
    'marker-replay-old-cursor',
    replayChunkBody,
  );
  assert.equal(replayOldCursor.success, true, replayOldCursor.error);
  assert.deepEqual(replayOldCursor.nextCursor, firstCursor);
  assert.equal(vfs.readFileString('marker-replay/first.txt'), 'first');
  assert.equal(
    JSON.parse(vfs.readFileString('marker-replay/.git/nimbus-clone-job')).cursorSeq,
    2,
    'idempotent old-cursor replay did not durably acknowledge another committed chunk',
  );
  const replayFinal = await replayPhase(
    'clone-checkout',
    'marker-replay-final',
    { ...replayChunkBody, checkoutCursor: firstCursor },
  );
  assert.equal(replayFinal.success, true, replayFinal.error);
  assert.equal(replayFinal.nextCursor, null);
  assert.equal(vfs.readFileString('marker-replay/second.txt'), 'second');
  assert.equal(vfs.exists('marker-replay/.git/nimbus-clone-job'), false);

  const terminalJobId = 'terminal-replay-job';
  const terminalOptionsHash = 'e'.repeat(64);
  const terminalPhase = async (phase, invocationId, body, phaseSupervisor = supervisor) => {
    const response = await facetWorker.default.fetch(
      new Request(`http://git/git/${phase}/${invocationId}`, {
        method: 'POST',
        body: JSON.stringify({
          op: 'clone',
          dir: '/terminal-replay',
          url: 'https://example.invalid/repo.git',
          exclusiveDestination: true,
          phase,
          invocationId,
          jobId: terminalJobId,
          optionsHash: terminalOptionsHash,
          phaseDeadline: Date.now() + 30_000,
          ...body,
        }),
      }),
      { SUPERVISOR: phaseSupervisor },
    );
    return response.json();
  };
  const terminalPrepare = await terminalPhase(
    'clone-prepare',
    'terminal-replay-prepare',
    {},
  );
  assert.equal(terminalPrepare.success, true, terminalPrepare.error);
  const terminalChunkBody = {
    prepared: terminalPrepare.prepared,
    checkoutCursor: null,
    checkoutBounds: {
      maxEntries: 10_000,
      maxDecodedBytes: 32 * 1024 * 1024,
      maxWallMs: 20_000,
    },
  };
  const terminalFirst = await terminalPhase(
    'clone-checkout',
    'terminal-replay-first',
    terminalChunkBody,
  );
  assert.equal(terminalFirst.success, true, terminalFirst.error);
  let terminalWrite = 0;
  const terminalFailingSupervisor = {
    ...supervisor,
    async writeBatchStream(stream) {
      terminalWrite++;
      if (terminalWrite >= 2) {
        await new Response(stream).arrayBuffer();
        throw new Error('injected terminal acknowledgement failure');
      }
      return supervisor.writeBatchStream(stream);
    },
  };
  const terminalFailed = await terminalPhase(
    'clone-checkout',
    'terminal-replay-failed-final',
    { ...terminalChunkBody, checkoutCursor: firstCursor },
    terminalFailingSupervisor,
  );
  assert.equal(terminalFailed.success, false, 'terminal acknowledgement failure reported success');
  assert.match(terminalFailed.error, /injected terminal acknowledgement failure/);
  assert.equal(vfs.exists('terminal-replay/.git/nimbus-clone-job'), true,
    'failed terminal acknowledgement removed the replay cursor');
  assert.equal(vfs.exists('terminal-replay/.git/nimbus-checkout-index/00000000'), true,
    'failed terminal acknowledgement removed the replay index fragment');
  const terminalRetry = await terminalPhase(
    'clone-checkout',
    'terminal-replay-retry-final',
    { ...terminalChunkBody, checkoutCursor: firstCursor },
  );
  assert.equal(terminalRetry.success, true, terminalRetry.error);
  assert.equal(vfs.exists('terminal-replay/.git/nimbus-clone-job'), false);
  assert.equal(vfs.exists('terminal-replay/.git/nimbus-checkout-index'), false);

  for (const failurePoint of ['before', 'during', 'after']) {
    const dir = `chunk-failure-${failurePoint}`;
    const failingSupervisor = {
      ...supervisor,
      async writeBatchStream(stream) {
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        const paths = await drainWave(byteStream(bytes.slice()));
        if (!paths.includes(`${dir}/second.txt`)) {
          return vfs.writeStream(byteStream(bytes.slice()));
        }
        if (failurePoint === 'before') {
          throw new Error('injected before-flush failure');
        }
        const durable = await vfs.writeStream(byteStream(bytes.slice()));
        assert.equal(durable.ok, true);
        if (failurePoint === 'during') {
          return {
            ok: false,
            committedGroupSequence: 1,
            committedPathCount: 1,
            error: { message: 'injected during-flush failure' },
          };
        }
        throw new Error('injected after-flush response loss');
      },
    };
    const failedChunk = await runChunkedClone(dir, failingSupervisor);
    assert.equal(failedChunk.success, false, `${failurePoint} flush failure reported success`);
    assert.equal(failedChunk.errorPhase, 'clone-checkout');
    assert.match(failedChunk.error, new RegExp(`injected ${failurePoint}`));
    assert.equal(vfs.readFileString(`${dir}/first.txt`), 'first',
      `${failurePoint} flush failure lost the prior durable chunk`);
    assert.equal(vfs.exists(`${dir}/.git`), false,
      `${failurePoint} flush failure did not run the owned abort`);
  }

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

  const repoGitBefore = await bridge.readFile('/repo/.git/HEAD');
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
        phaseDeadline: Date.now() + 30_000,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const abort = await abortResponse.json();
  assert.equal(abort.success, true, abort.error);
  assert.equal(abort.refused, 'not-owner');
  assert.equal(vfs.exists('repo/.git'), true, 'unowned abort deleted Git metadata');
  assert.deepEqual(await bridge.readFile('/repo/.git/HEAD'), repoGitBefore,
    'unowned abort changed pre-existing Git metadata bytes');
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
        phaseDeadline: Date.now() + 30_000,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const repeatedAbort = await repeatedAbortResponse.json();
  assert.equal(repeatedAbort.success, true, repeatedAbort.error);
  assert.equal(repeatedAbort.refused, 'not-owner');

  const foreignMarkerBytes = new TextEncoder().encode(JSON.stringify({
    version: 1,
    jobId: 'different-job',
    optionsHash: 'e'.repeat(64),
  }));
  await bridge.writeFile('/repo/.git/nimbus-clone-job', foreignMarkerBytes);
  const mismatchedAbortResponse = await coldWorker.default.fetch(
    new Request('http://git/git/clone-abort/mismatched-abort', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/repo',
        phase: 'clone-abort',
        invocationId: 'mismatched-abort',
        jobId: 'abort-job',
        optionsHash: 'b'.repeat(64),
        phaseDeadline: Date.now() + 30_000,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const mismatchedAbort = await mismatchedAbortResponse.json();
  assert.equal(mismatchedAbort.success, true, mismatchedAbort.error);
  assert.equal(mismatchedAbort.refused, 'not-owner');
  assert.deepEqual(
    await bridge.readFile('/repo/.git/nimbus-clone-job'),
    foreignMarkerBytes,
    'abort changed a mismatched ownership marker',
  );
  await bridge.unlink('/repo/.git/nimbus-clone-job');

  const ownedJobId = 'cold-owned-abort-job';
  const ownedOptionsHash = 'c'.repeat(64);
  const ownedPrepareResponse = await facetWorker.default.fetch(
    new Request('http://git/git/clone-prepare/owned-prepare', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/owned-abort',
        url: 'https://example.invalid/repo.git',
        exclusiveDestination: true,
        phase: 'clone-prepare',
        invocationId: 'owned-prepare',
        jobId: ownedJobId,
        optionsHash: ownedOptionsHash,
        phaseDeadline: Date.now() + 30_000,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const ownedPrepare = await ownedPrepareResponse.json();
  assert.equal(ownedPrepare.success, true, ownedPrepare.error);
  assert.equal(vfs.exists('owned-abort/.git/nimbus-clone-job'), true,
    'prepare did not persist its ownership marker');
  assert.deepEqual(
    JSON.parse(vfs.readFileString('owned-abort/.git/nimbus-clone-job')),
    {
      version: 2,
      jobId: ownedJobId,
      optionsHash: ownedOptionsHash,
      prepared: {
        commit: '1'.repeat(40),
        tree: '2'.repeat(40),
        headRef: 'refs/heads/main',
      },
      cursor: null,
      cursorSeq: 0,
    },
  );
  const ownedAbortResponse = await coldWorker.default.fetch(
    new Request('http://git/git/clone-abort/owned-abort', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/owned-abort',
        phase: 'clone-abort',
        invocationId: 'owned-abort',
        jobId: ownedJobId,
        optionsHash: ownedOptionsHash,
        phaseDeadline: Date.now() + 30_000,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const ownedAbort = await ownedAbortResponse.json();
  assert.equal(ownedAbort.success, true, ownedAbort.error);
  assert.equal(ownedAbort.refused, undefined);
  assert.equal(vfs.exists('owned-abort/.git'), false,
    'cold-isolate abort with a valid ownership marker left Git metadata behind');

  await bridge.mkdir('/existing-repo/.git', { recursive: true });
  const existingBytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  await bridge.writeFile('/existing-repo/.git/sentinel', existingBytes);
  const existingPhases = [];
  setCtxExports({ SupervisorRPC: () => supervisor });
  const existingResult = await execGitNetwork(
    { id: { toString: () => 'closed-world-do' } },
    {
      LOADER: {
        load() {
          return {
            getEntrypoint() {
              return {
                async fetch(request) {
                  existingPhases.push((await request.clone().json()).phase);
                  return facetWorker.default.fetch(request, { SUPERVISOR: supervisor });
                },
              };
            },
          };
        },
      },
    },
    {
      op: 'clone',
      dir: '/existing-repo',
      url: 'https://example.invalid/repo.git',
      exclusiveDestination: true,
      exclusiveMutationRoot: 'existing-repo',
      mutationOwner: 'owner',
    },
  );
  assert.equal(existingResult.success, false);
  assert.match(existingResult.error, /already exists and is not an empty directory/);
  assert.deepEqual(existingPhases, ['clone-prepare'],
    'pre-mutation destination refusal incorrectly invoked clone-abort');
  assert.deepEqual(await bridge.readFile('/existing-repo/.git/sentinel'), existingBytes,
    'clone into an existing repository changed its Git metadata bytes');

  const expiredResponse = await coldWorker.default.fetch(
    new Request('http://git/git/clone-prepare/expired-prepare', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/expired',
        url: 'https://example.invalid/repo.git',
        exclusiveDestination: true,
        phase: 'clone-prepare',
        invocationId: 'expired-prepare',
        jobId: 'expired-job',
        optionsHash: 'd'.repeat(64),
        phaseDeadline: Date.now() - 1,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const expired = await expiredResponse.json();
  assert.equal(expired.success, false);
  assert.match(expired.error, /phase deadline/);
  assert.equal(vfs.exists('expired/.git'), false,
    'facet started a new write wave after its phase deadline');

  const progressStart = rawCalls.stdout;
  const progressResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({
        op: 'clone',
        dir: '/progress',
        url: 'https://example.invalid/repo.git',
        exclusiveDestination: true,
      }),
    }),
    { SUPERVISOR: supervisor },
  );
  const progress = await progressResponse.json();
  assert.equal(progress.success, true, progress.error);
  assert.ok(rawCalls.stdout >= progressStart + 2,
    'checkout did not emit time-throttled progress after two seconds');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('git network facet closed-world adapter: ok');
