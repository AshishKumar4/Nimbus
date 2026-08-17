import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CHUNK_SIZE } from '../../packages/core/src/constants.ts';
import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { getSymlinkRegistry } from '../../packages/core/src/vfs/symlink-registry.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

// A W7 wave holding a file larger than CHUNK_SIZE must not materialize a
// second full copy of the file beside the writeBuffer original: chunk-record
// copies are created lazily, one per encoder pull, while the stream is being
// drained. An eager per-chunk slice() in buildPayload made the oversize
// single-file wave (a packfile) peak at 2× its size — the facet OOM shape.
// This test pins pull-time materialization by counting slices taken from the
// pack-sized parent while the receiver drains the wave, and pins the
// clone-job lifecycle (warm within the clone, entry gone after completion).

const tempDir = mkdtempSync(join(tmpdir(), 'nimbus-git-facet-wave-memory-'));

// 4 chunks: 3 full + one 977-byte tail. The byteLength is unique in the
// test, so slices taken FROM the pack parent are unambiguous.
const PACK_SIZE = 3 * CHUNK_SIZE + 977;
const PACK_SHA = '3'.repeat(40);
const originalSlice = Uint8Array.prototype.slice;

try {
  writeFileSync(join(tempDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  writeFileSync(join(tempDir, 'git-bundle.js'), `
const enc = new TextEncoder();
export const gitHttp = {};
export const git = {
  async clone({ fs, dir, cache, ref }) {
    if (ref !== 'main') throw new Error('clone did not receive the requested ref');
    const root = dir.replace(/^\\/+/, '');
    const packDir = root + '/.git/objects/pack';
    const pack = new Uint8Array(${PACK_SIZE});
    for (let i = 0; i < pack.length; i++) pack[i] = (i * 31 + 7) & 0xff;
    await fs.promises.mkdir(packDir);
    await fs.promises.writeFile(packDir + '/pack-${PACK_SHA}.pack', pack);
    await fs.promises.writeFile(packDir + '/pack-${PACK_SHA}.idx', enc.encode('idx'));
    await fs.promises.mkdir(root + '/.git/refs/heads');
    await fs.promises.writeFile(root + '/.git/HEAD', 'ref: refs/heads/main\\n');
    await fs.promises.writeFile(root + '/.git/refs/heads/main', '1'.repeat(40) + '\\n');
    cache.prepared = true;
  },
  async resolveRef() { return '1'.repeat(40); },
  async readCommit() { return { commit: { tree: '2'.repeat(40) } }; },
  async currentBranch({ test }) { return test ? 'refs/heads/main' : 'refs/heads/main'; },
  async checkoutFreshChunk({ fs, dir }) {
    await fs.promises.writeFile(dir.replace(/^\\/+/, '') + '/hello.txt', 'hello');
    return {
      nextCursor: null,
      files: 1,
      decodedBytes: 5,
      treeEntriesVisited: 1,
      indexEntries: 1,
    };
  },
};
`);

  const facetWorker = await import(pathToFileURL(join(tempDir, 'git-network-worker.mjs')).href);

  const harness = createSqliteVfsTestHarness();
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  const vfs = rawVfs.as(CRED_KERNEL);
  const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);

  // Count slices taken from the pack-sized parent while a wave is drained.
  let drainSliceLengths = null;
  Uint8Array.prototype.slice = function slice(...args) {
    const result = originalSlice.apply(this, args);
    if (drainSliceLengths !== null && this.byteLength === PACK_SIZE) {
      drainSliceLengths.push(result.byteLength);
    }
    return result;
  };

  const supervisor = {
    async stat(path) { return bridge.stat(path); },
    async lstat(path) { return bridge.stat(path, { followSymlinks: false }); },
    async hasLegacySymlinkUnder(path) {
      return getSymlinkRegistry(rawVfs).hasAtOrBelow(path);
    },
    async readdir(path) { return bridge.readdir(path); },
    async readFileBytes(path) { return bridge.readFile(path); },
    async fsReadRange() { throw new Error('unexpected fsReadRange'); },
    async writeBatchStream(stream) {
      assert.equal(drainSliceLengths, null, 'overlapping wave drains');
      drainSliceLengths = [];
      try {
        return await vfs.writeStream(stream);
      } finally {
        allDrainSlices.push(...drainSliceLengths);
        drainSliceLengths = null;
      }
    },
    async stdout() {},
  };
  const allDrainSlices = [];

  const jobId = 'wave-memory-job';
  const optionsHash = 'd'.repeat(64);
  const phase = async (phaseName, invocationId, body) => {
    const response = await facetWorker.default.fetch(
      new Request(`http://git/git/${phaseName}/${invocationId}`, {
        method: 'POST',
        body: JSON.stringify({
          op: 'clone',
          dir: '/wave-repo',
          url: 'https://example.invalid/repo.git',
          ref: 'main',
          exclusiveDestination: true,
          phase: phaseName,
          invocationId,
          jobId,
          optionsHash,
          phaseDeadline: Date.now() + 30_000,
          ...body,
        }),
      }),
      { SUPERVISOR: supervisor },
    );
    return response.json();
  };

  const prepare = await phase('clone-prepare', 'wave-memory-prepare', {});
  assert.equal(prepare.success, true, prepare.error);

  // Every chunk-sized copy of the pack was materialized while the receiver
  // drained the wave — none eagerly at payload-build time. Exactly one copy
  // per chunk, in chunk order.
  assert.deepEqual(
    allDrainSlices,
    [CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE, PACK_SIZE - 3 * CHUNK_SIZE],
    'pack chunk copies were not materialized lazily during the wave drain',
  );

  // The lazily-copied pack round-tripped byte-identically.
  const persisted = vfs.readFile(`wave-repo/.git/objects/pack/pack-${PACK_SHA}.pack`);
  assert.equal(persisted.byteLength, PACK_SIZE);
  for (let i = 0; i < persisted.length; i++) {
    if (persisted[i] !== ((i * 31 + 7) & 0xff)) {
      assert.fail(`persisted pack diverged at byte ${i}`);
    }
  }

  const checkoutBody = {
    prepared: prepare.prepared,
    checkoutCursor: null,
    checkoutBounds: {
      maxEntries: 10_000,
      maxDecodedBytes: 32 * 1024 * 1024,
      maxWallMs: 20_000,
    },
  };
  const checkout = await phase('clone-checkout', 'wave-memory-checkout', checkoutBody);
  assert.equal(checkout.success, true, checkout.error);
  assert.equal(checkout.nextCursor, null);
  assert.equal(checkout.cold, false, 'checkout in the same facet did not reuse the warm job');
  assert.equal(vfs.readFileString('wave-repo/hello.txt'), 'hello');
  assert.equal(vfs.exists('wave-repo/.git/nimbus-clone-job'), false,
    'completed checkout left the ownership marker behind');

  // Completion removed the module-local clone job: a replay of the same
  // jobId starts cold and no longer owns the (deleted) marker.
  const replay = await phase('clone-checkout', 'wave-memory-replay', checkoutBody);
  assert.equal(replay.success, false, 'replay after completion unexpectedly succeeded');
  assert.match(replay.error, /clone job marker does not match/);
  assert.equal(replay.cold, true, 'completed clone job was still warm in cloneJobs');

  console.log('git network facet wave memory: ok');
} finally {
  Uint8Array.prototype.slice = originalSlice;
  rmSync(tempDir, { recursive: true, force: true });
}
