#!/usr/bin/env bun
// npm-install-nested-shared-tarball — one version placed at two directories
// is fetched once and written twice.
//
// A version conflict can nest the same version under two dependents (root
// holds c@1; b and e both need c@^2, so each gets c@2.0.0 under itself). The
// supervisor keeps a tarball's placements in one shard, and the shard's
// first owner of a URL publishes its bytes to the later ones. Pinned through
// installPackagesInFacet, counting registry requests at globalThis.fetch and
// the directories the write stream lands, the same seams
// npm-install-tarball-hedge.mjs uses.

import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import {
  readableStreamToAsyncIterable,
  streamPackageEntries,
  streamTarEntries,
} from '../../packages/core/src/_shared/tarball-stream.ts';
import {
  decodeWriteBatchStream,
  encodeWriteBatchStream,
} from '../../packages/platform/src/w7-frame.ts';

globalThis.streamPackageEntries = streamPackageEntries;
globalThis.streamTarEntries = streamTarEntries;
globalThis.readableStreamToAsyncIterable = readableStreamToAsyncIterable;
globalThis.encodeWriteBatchStream = encodeWriteBatchStream;
globalThis.__nimbusUseRpcResult = async (promise, use) => use(await promise);
globalThis.DecompressionStream = class DecompressionStream {
  readable;
  writable;

  constructor(format) {
    assert.equal(format, 'gzip');
    const transform = new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(gunzipSync(chunk));
      },
    });
    this.readable = transform.readable;
    this.writable = transform.writable;
  }
};

function octal(value, width) {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function tarFile(name, text) {
  const data = new TextEncoder().encode(text);
  const header = new Uint8Array(512);
  const write = (offset, value, width) => {
    header.set(new TextEncoder().encode(value).subarray(0, width), offset);
  };
  write(0, name, 100);
  write(100, octal(0o644, 8), 8);
  write(108, octal(0, 8), 8);
  write(116, octal(0, 8), 8);
  write(124, octal(data.length, 12), 12);
  write(136, octal(0, 12), 12);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  write(257, 'ustar\0', 6);
  write(263, '00', 2);
  write(148, octal(header.reduce((sum, byte) => sum + byte, 0), 8), 8);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return [header, padded];
}

function makeTarball() {
  const parts = [
    ...tarFile('package/package.json', '{"name":"c","version":"2.0.0"}'),
    ...tarFile('package/index.js', 'module.exports = 2;'),
    new Uint8Array(1024),
  ];
  const tar = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(gzipSync(tar));
}

async function sriOf(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));
  let bin = '';
  for (const byte of digest) bin += String.fromCharCode(byte);
  return `sha512-${btoa(bin)}`;
}

const TARBALL = makeTarball();
const SRI = await sriOf(TARBALL);
const TARBALL_URL = 'https://registry.invalid/c-2.0.0.tgz';
const NM = 'app/node_modules';

const written = new Set();
const supervisor = {
  async writeBatchStream(stream) {
    const decoded = await decodeWriteBatchStream(stream);
    let paths = 0;
    for await (const record of decoded.records) {
      if (record.type === 'directory' || record.type === 'file-begin') { paths++; written.add(record.inode.path); }
      if (record.type === 'file-chunk') record.retention.release();
    }
    return { ok: true, committedGroupSequence: paths, committedPathCount: paths, inodes: paths, chunks: 0 };
  },
  async getCachedTarball() { return { bytes: null, events: [] }; },
  async putCachedTarball() { /* write-back is not under test */ },
};

const placement = (dir) => ({
  name: 'c', version: '2.0.0', tarballUrl: TARBALL_URL, integrity: SRI,
  pkgDir: `${NM}/${dir}`, installRoot: NM, mtime: 1, chunkSize: 65_536,
});

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  return new Response(TARBALL.slice(), { status: 200, headers: { 'content-length': String(TARBALL.length) } });
};

const result = await installPackagesInFacet(
  { packages: [placement('b/node_modules/c'), placement('e/node_modules/c')], concurrency: 3 },
  { SUPERVISOR: supervisor },
);
globalThis.fetch = originalFetch;

for (const r of result.perPackage) assert.ok(!r.errorText, `${r.pkgDir}: ${r.errorText}`);
assert.equal(fetchCalls, 1, 'one tarball, one registry request');
assert.deepEqual(
  result.perPackage.map((r) => r.pkgDir).sort(),
  [`${NM}/b/node_modules/c`, `${NM}/e/node_modules/c`],
  'each result names its own placement',
);
for (const dir of ['b/node_modules/c', 'e/node_modules/c']) {
  assert.ok(written.has(`${NM}/${dir}/index.js`), `${dir}/index.js written`);
  assert.ok(written.has(`${NM}/${dir}/package.json`), `${dir}/package.json written`);
}
assert.ok(written.has(`${NM}/b/node_modules`) && written.has(`${NM}/e/node_modules`), 'the nested node_modules dirs are staged');
console.log(`  2 placements, ${fetchCalls} fetch, ${[...written].filter((p) => p.endsWith('/index.js')).length} index.js written`);
console.log('npm-install-nested-shared-tarball: ok');
