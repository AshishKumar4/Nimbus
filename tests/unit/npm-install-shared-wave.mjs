#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import {
  readableStreamToAsyncIterable,
  streamTarEntries,
} from '../../packages/worker/src/npm/tarball-stream.ts';
import {
  decodeWriteBatchStream,
  encodeWriteBatchStream,
} from '../../packages/core/src/_shared/w7-frame.ts';

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
  // package.json deliberately arrives first; the facet must hold it back as
  // the owner's final completion mutation.
  const parts = [
    ...tarFile('package/package.json', '{"name":"fixture","version":"1.0.0"}'),
    ...tarFile('package/index.js', 'export default 1;'),
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

async function decodeWave(stream) {
  const decoded = await decodeWriteBatchStream(stream);
  const paths = [];
  let chunks = 0;
  for await (const record of decoded.records) {
    if (record.type === 'directory' || record.type === 'file-begin') {
      paths.push(record.inode.path);
    } else if (record.type === 'file-chunk') {
      chunks++;
      record.retention.release();
    }
  }
  return { paths, chunks };
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
  chunkSize: 65_536,
}));

const result = await installPackagesInFacet({ packages, concurrency: 2 }, env);
assert.equal(result.perPackage.length, 2);
assert.ok(result.perPackage.every((pkg) => pkg.errorText?.includes('injected wave failure')));
assert.equal(
  inodePaths.flat().some((path) => path.endsWith('/package.json')),
  false,
  'a failed content wave must prevent every participating owner marker from publishing',
);

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

// Producer preflushes before 128 paths and never overlaps W7 RPCs even when
// many package pipelines reach the shared wave concurrently.
{
  const manyPackages = Array.from({ length: 130 }, (_, index) => ({
    name: `pkg-${index}`,
    version: '1.0.0',
    tarballUrl: `https://unused.invalid/pkg-${index}`,
    integrity: '',
    pkgDir: `node_modules/pkg-${index}`,
    installRoot: 'node_modules',
    mtime: 1,
    chunkSize: 65_536,
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
  assert.ok(pathCounts.every((count) => count <= 128), `oversize wave paths: ${pathCounts}`);
}

console.log('npm shared write wave ownership: ok');
