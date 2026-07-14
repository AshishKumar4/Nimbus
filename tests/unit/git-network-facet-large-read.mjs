import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MAX_RPC_SAFE_PAYLOAD_BYTES } from '../../packages/worker/src/constants.ts';
import { assembleGitNetworkFacetSource } from '../../packages/worker/src/git/network-facet.ts';

const LARGE_FILE_BYTES = MAX_RPC_SAFE_PAYLOAD_BYTES + 1;
const RANGE_CONTENT_BYTES = 4 * 1024 * 1024;
const PACK_PATH = 'repo/.git/objects/pack/pack-test.pack';
const tempDir = mkdtempSync(join(tmpdir(), 'nimbus-git-facet-large-read-'));

try {
  writeFileSync(join(tempDir, 'git-network-worker.mjs'), assembleGitNetworkFacetSource());
  writeFileSync(join(tempDir, 'git-bundle.js'), `
export const gitHttp = {};
export const git = {
  async fetch({ fs, dir }) {
    const bytes = await fs.promises.readFile(dir + '/.git/objects/pack/pack-test.pack');
    if (!(bytes instanceof Uint8Array)) throw new Error('pack read did not return bytes');
    const expectedSize = dir === '/repo' ? ${LARGE_FILE_BYTES} : 3;
    if (bytes.byteLength !== expectedSize) {
      throw new Error('pack read returned ' + bytes.byteLength + ' bytes');
    }
    const expectedLast = dir === '/repo' ? ${Math.floor((LARGE_FILE_BYTES - 1) / RANGE_CONTENT_BYTES)} : 3;
    if (bytes[0] !== (dir === '/repo' ? 0 : 1) || bytes[bytes.byteLength - 1] !== expectedLast) {
      throw new Error('pack read returned incorrect range content');
    }
  },
};
`);

  const calls = { whole: 0, ranges: [] };
  const supervisor = {
    async stat(path) {
      assert.equal(path, PACK_PATH);
      return { type: 'file', size: LARGE_FILE_BYTES, mode: 0o644, mtime: Date.now() };
    },
    async readFileBytes() {
      calls.whole++;
      throw new Error('structured clone payload exceeds RPC limit');
    },
    async fsReadRange(path, offset, length) {
      assert.equal(path, PACK_PATH);
      calls.ranges.push({ offset, length });
      const bytes = new Uint8Array(Math.min(length, LARGE_FILE_BYTES - offset));
      bytes.fill(Math.floor(offset / RANGE_CONTENT_BYTES));
      return bytes;
    },
    async stdout() {},
  };

  const worker = await import(pathToFileURL(join(tempDir, 'git-network-worker.mjs')).href);
  const response = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'fetch', dir: '/repo' }),
    }),
    { SUPERVISOR: supervisor },
  );
  const result = await response.json();

  assert.equal(result.success, true, result.error);
  assert.equal(calls.whole, 0, 'large files must not cross the whole-file RPC boundary');
  assert.ok(calls.ranges.length > 1, 'large file must be split across bounded range RPCs');
  let nextOffset = 0;
  for (const range of calls.ranges) {
    assert.equal(range.offset, nextOffset, 'range reads must be contiguous');
    assert.ok(range.length > 0 && range.length <= MAX_RPC_SAFE_PAYLOAD_BYTES);
    nextOffset += range.length;
  }
  assert.equal(nextOffset, LARGE_FILE_BYTES, 'range reads must cover the whole file exactly');

  const smallCalls = { whole: 0, ranges: 0 };
  const smallResponse = await worker.default.fetch(
    new Request('http://git/op', {
      method: 'POST',
      body: JSON.stringify({ op: 'fetch', dir: '/small' }),
    }),
    {
      SUPERVISOR: {
        async stat(path) {
          assert.equal(path, 'small/.git/objects/pack/pack-test.pack');
          return { type: 'file', size: 3, mode: 0o644, mtime: Date.now() };
        },
        async readFileBytes(path) {
          assert.equal(path, 'small/.git/objects/pack/pack-test.pack');
          smallCalls.whole++;
          return Uint8Array.of(1, 2, 3);
        },
        async fsReadRange() {
          smallCalls.ranges++;
          throw new Error('small files must not use ranged reads');
        },
        async stdout() {},
      },
    },
  );
  const smallResult = await smallResponse.json();
  assert.equal(smallResult.success, true, smallResult.error);
  assert.equal(smallCalls.whole, 1);
  assert.equal(smallCalls.ranges, 0);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('git network facet large read: ok');
