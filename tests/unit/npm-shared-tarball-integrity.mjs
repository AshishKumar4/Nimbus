#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import { packageTarball, sriOf, decodeWave } from './lib/tarball-fixture.mjs';
import './lib/install-facet-scope.mjs';

const tarballA = packageTarball({ 'package/package.json': '{"name":"a","version":"1.0.0"}', 'package/image.wasm': 'image-A' });
const tarballB = packageTarball({ 'package/package.json': '{"name":"b","version":"1.0.0"}', 'package/image.wasm': 'image-B' });
const integrityA = await sriOf(tarballA);
const integrityB = await sriOf(tarballB);
const url = 'https://registry.invalid/shared.tgz';
const realFetch = globalThis.fetch;
try {
  for (const shape of ['same-url', 'nul-collision', 'matching']) {
    const urls = shape === 'nul-collision' ? [url + '\u0000' + integrityB + ' ', url] : [url, url];
    const integrities = shape === 'nul-collision' ? [integrityA, integrityB + ' \u0000' + integrityA]
      : shape === 'matching' ? [integrityA, integrityA] : [integrityA, integrityB];
    const fetched = [];
    globalThis.fetch = async (input) => {
      fetched.push(String(input));
      // Neither address actually supplies B's expected bytes. A shared
      // download must not turn that integrity failure into a success.
      return new Response(tarballA.slice());
    };
    const waves = [];
    const result = await installPackagesInFacet({ packages: ['a', 'b'].map((name, index) => ({
      name, version: '1.0.0', tarballUrl: urls[index], integrity: integrities[index],
      pkgDir: `node_modules/${name}`, installRoot: 'node_modules', mtime: 1,
    })), concurrency: 2 }, { SUPERVISOR: {
      async writeBatchStream(stream) {
        const decoded = await decodeWave(stream);
        waves.push(...decoded.paths);
        return { ok: true, committedGroupSequence: decoded.paths.length, committedPathCount: decoded.paths.length, inodes: decoded.paths.length, chunks: decoded.chunks };
      },
    } });
    assert.equal(result.perPackage[0].errorText, undefined);
    if (shape === 'matching') {
      assert.equal(result.perPackage[1].errorText, undefined);
      assert.equal(fetched.length, 1, 'identical URL+SRI still share their verified download');
      assert.ok(waves.includes('node_modules/b/package.json'));
    } else {
      assert.match(result.perPackage[1].errorText ?? '', /integrity mismatch/, `${shape}: B must verify its own expected digest even when A supplied shared bytes`);
      assert.ok(!waves.includes('node_modules/b/package.json'), 'a failed tarball never publishes its completion marker');
    }
  }
  // Digest work: N same-URL/same-SRI placements sharing one download hash
  // exactly once — the owner's fetch verification. Consumers compare digests.
  const sharers = 4;
  const sharedTarball = packageTarball({ 'package/package.json': '{"name":"s","version":"1.0.0"}' });
  const sharedIntegrity = await sriOf(sharedTarball);
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(sharedTarball.slice()); };
  const subtle = globalThis.crypto.subtle;
  const rawDigest = subtle.digest.bind(subtle);
  let hashes = 0;
  globalThis.crypto.subtle.digest = (...args) => { hashes++; return rawDigest(...args); };
  try {
    const shared = await installPackagesInFacet({ packages: Array.from({ length: sharers }, (_, index) => ({
      name: `s${index}`, version: '1.0.0', tarballUrl: url, integrity: sharedIntegrity,
      pkgDir: `node_modules/s${index}`, installRoot: 'node_modules', mtime: 1,
    })), concurrency: sharers }, { SUPERVISOR: {
      async writeBatchStream(stream) {
        const decoded = await decodeWave(stream);
        return { ok: true, committedGroupSequence: decoded.paths.length, committedPathCount: decoded.paths.length, inodes: decoded.paths.length, chunks: decoded.chunks };
      },
    } });
    assert.ok(shared.perPackage.every((result) => result.errorText === undefined));
    assert.equal(fetches, 1, 'one download serves every same-key placement');
    assert.equal(hashes, 1, `one digest computation per fetch, not per consumer (got ${hashes})`);
  } finally { globalThis.crypto.subtle.digest = rawDigest; }
} finally { globalThis.fetch = realFetch; }
console.log('npm-shared-tarball-integrity: matching reuse, both adversarial pairs, and single-hash sharing passed');
