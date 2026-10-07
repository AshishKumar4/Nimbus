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
import { gunzipSync } from 'node:zlib';
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
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';
import './lib/install-facet-scope.mjs';


function makeTarball() {
  return packageTarball({
    'package/package.json': '{"name":"c","version":"2.0.0"}',
    'package/index.js': 'module.exports = 2;',
  });
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
