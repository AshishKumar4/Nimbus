import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CHUNK_SIZE } from '../../packages/platform/src/limits.ts';
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
// pack-sized parent while the receiver drains the wave. The writes come from
// a git fetch: its buffered fs is the facet's one wave writer.

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
  async fetch({ fs, dir, remote }) {
    if (remote !== 'origin') throw new Error('fetch did not receive the remote');
    const root = dir.replace(/^\\/+/, '');
    const packDir = root + '/.git/objects/pack';
    const pack = new Uint8Array(${PACK_SIZE});
    for (let i = 0; i < pack.length; i++) pack[i] = (i * 31 + 7) & 0xff;
    await fs.promises.mkdir(packDir);
    await fs.promises.writeFile(packDir + '/pack-${PACK_SHA}.pack', pack);
    await fs.promises.writeFile(packDir + '/pack-${PACK_SHA}.idx', enc.encode('idx'));
    await fs.promises.writeFile(root + '/.git/refs/remotes/origin/main', '1'.repeat(40) + '\\n');
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

  vfs.mkdir('wave-repo/.git/refs/remotes/origin', { recursive: true });
  const response = await facetWorker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'fetch', dir: '/wave-repo', remote: 'origin' }),
    }),
    { SUPERVISOR: supervisor },
  );
  const fetched = await response.json();
  assert.equal(fetched.success, true, fetched.error);

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

  assert.equal(vfs.readFileString('wave-repo/.git/refs/remotes/origin/main'), '1'.repeat(40) + '\n');

  console.log('git network facet wave memory: ok');
} finally {
  Uint8Array.prototype.slice = originalSlice;
  rmSync(tempDir, { recursive: true, force: true });
}
