#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import {
  readableStreamToAsyncIterable,
  streamPackageEntries,
  streamTarEntries,
} from '../../packages/core/src/_shared/tarball-stream.ts';
import {
  encodeWriteBatchStream,
} from '../../packages/platform/src/w7-frame.ts';
import { decodeWave, packageTarball } from './lib/tarball-fixture.mjs';
import './lib/install-facet-scope.mjs';

const { WAVE_PATHS } = globalThis.__nimbusWaveWriter;

// package.json deliberately arrives first; the facet must hold it back as
// the owner's final completion mutation.
function makeTarball(entries = [
  ['package/package.json', '{"name":"fixture","version":"1.0.0"}'],
  ['package/index.js', 'export default 1;'],
]) {
  return packageTarball(entries);
}

const tarball = makeTarball();
const inodePaths = [];
const env = {
  SUPERVISOR: {
    async getCachedTarball() {
      return { bytes: tarball.slice(), events: [] };
    },
    async writeBatchStream(stream) {
      const decoded = await decodeWave(stream);
      inodePaths.push(decoded.paths);
      return {
        ok: false,
        committedGroupSequence: 1,
        committedPathCount: 2,
        inodes: 2,
        chunks: 1,
        error: {
          code: 'ERR_WRITE_BATCH_STREAM',
          phase: 'publish',
          message: 'injected wave failure',
        },
      };
    },
  },
};
const packages = ['a', 'b'].map((name) => ({
  name,
  version: '1.0.0',
  tarballUrl: `https://unused.invalid/${name}`,
  integrity: '',
  pkgDir: `node_modules/${name}`,
  installRoot: 'node_modules',
  mtime: 1,
}));

const result = await installPackagesInFacet({ packages, concurrency: 2 }, env);
assert.equal(result.perPackage.length, 2);
assert.ok(result.perPackage.every((pkg) => pkg.errorText?.includes('injected wave failure')));
// A marker may share a wave with its package's files, but always follows
// them: a wave commits its records in order, so a refused wave that left
// the files unpublished left the marker unpublished too.
assert.equal(inodePaths.length, 1, 'a wave was sent after one the session refused');
for (const name of ['a', 'b']) {
  const order = inodePaths.flat();
  const marker = order.indexOf(`node_modules/${name}/package.json`);
  assert.ok(marker === -1 || marker > order.indexOf(`node_modules/${name}/index.js`),
    `${name}'s completion marker was sent ahead of its files`);
}

const successfulWaves = [];
const success = await installPackagesInFacet({ packages, concurrency: 2 }, {
  SUPERVISOR: {
    async getCachedTarball() {
      return { bytes: tarball.slice(), events: [] };
    },
    async writeBatchStream(stream) {
      const decoded = await decodeWave(stream);
      successfulWaves.push(decoded.paths);
      return {
        ok: true,
        committedGroupSequence: decoded.paths.length,
        committedPathCount: decoded.paths.length,
        inodes: decoded.paths.length,
        chunks: decoded.chunks,
      };
    },
  },
});
assert.ok(success.perPackage.every((pkg) => !pkg.errorText));
const publicationOrder = successfulWaves.flat();
for (const name of ['a', 'b']) {
  const ownerPrefix = `node_modules/${name}`;
  assert.ok(
    publicationOrder.indexOf(`${ownerPrefix}/index.js`)
      < publicationOrder.indexOf(`${ownerPrefix}/package.json`),
  );
  // Regression: the install root and package dir inodes must be published
  // in a wave at or before the wave carrying the package's files, so the
  // credentialed writeBatch never authorizes a file ahead of its parent
  // dir (which surfaced live as `ENOENT: .../node_modules`).
  assert.ok(publicationOrder.includes('node_modules'), 'install root dir inode must be staged');
  assert.ok(publicationOrder.includes(ownerPrefix), `${ownerPrefix} dir inode must be staged`);
  assert.ok(
    publicationOrder.indexOf('node_modules') <= publicationOrder.indexOf(`${ownerPrefix}/index.js`),
    'install root dir must not follow the files it parents',
  );
  assert.ok(
    publicationOrder.indexOf(ownerPrefix) <= publicationOrder.indexOf(`${ownerPrefix}/index.js`),
    'package dir must not follow the files it parents',
  );
}

// The producer cuts waves at the W7 bound and never overlaps W7 RPCs even
// when many package pipelines write concurrently.
{
  const manyPackages = Array.from({ length: 700 }, (_, index) => ({
    name: `pkg-${index}`,
    version: '1.0.0',
    tarballUrl: `https://unused.invalid/pkg-${index}`,
    integrity: '',
    pkgDir: `node_modules/pkg-${index}`,
    installRoot: 'node_modules',
    mtime: 1,
    }));
  let active = 0;
  let peakActive = 0;
  const pathCounts = [];
  const result = await installPackagesInFacet({ packages: manyPackages, concurrency: 10 }, {
    SUPERVISOR: {
      async getCachedTarball() {
        return { bytes: tarball.slice(), events: [] };
      },
      async writeBatchStream(stream) {
        active++;
        peakActive = Math.max(peakActive, active);
        try {
          const decoded = await decodeWave(stream);
          pathCounts.push(decoded.paths.length);
          await new Promise((resolve) => setTimeout(resolve, 2));
          return {
            ok: true,
            committedGroupSequence: decoded.paths.length,
            committedPathCount: decoded.paths.length,
            inodes: decoded.paths.length,
            chunks: decoded.chunks,
          };
        } finally {
          active--;
        }
      },
    },
  });
  assert.ok(result.perPackage.every((pkg) => !pkg.errorText));
  assert.equal(peakActive, 1, 'npm producer started overlapping flush RPCs');
  assert.ok(pathCounts.length > 1, 'path-limit fixture did not produce multiple waves');
  assert.ok(pathCounts.every((count) => count <= WAVE_PATHS), `oversize wave paths: ${pathCounts}`);
}

// A tarball may name one file twice: agent-base@7.1.4 and
// https-proxy-agent@7.0.6 ship both `package/./dist/index.js` and
// `package/dist/index.js`, one path once canonical. The second write
// supersedes the first in the buffered wave, and the package is published
// with it (it was reported unpublished: two writes, one record cut).
{
  const duplicated = makeTarball([
    ['package/./index.js', 'export default 0;'],
    ['package/index.js', 'export default 1;'],
    ['package/package.json', '{"name":"fixture","version":"1.0.0"}'],
  ]);
  const waves = [];
  const result = await installPackagesInFacet({ packages: packages.slice(0, 1), concurrency: 1 }, {
    SUPERVISOR: {
      async getCachedTarball() {
        return { bytes: duplicated.slice(), events: [] };
      },
      async writeBatchStream(stream) {
        const decoded = await decodeWave(stream);
        waves.push(decoded.paths);
        return {
          ok: true,
          committedGroupSequence: decoded.paths.length,
          committedPathCount: decoded.paths.length,
          inodes: decoded.paths.length,
          chunks: decoded.chunks,
        };
      },
    },
  });
  assert.equal(result.perPackage[0].errorText, undefined, 'a duplicated tarball entry left its package unpublished');
  assert.equal(waves.flat().filter((path) => path === 'node_modules/a/index.js').length, 1);
}

console.log('npm shared write wave ownership: ok');
