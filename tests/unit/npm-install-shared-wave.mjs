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
} from '../../packages/worker/src/_shared/w7-frame.ts';

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

const tarball = makeTarball();
const inodePaths = [];
const env = {
  SUPERVISOR: {
    async getCachedTarball() {
      return tarball.slice();
    },
    async writeBatchStream(stream) {
      const decoded = await decodeWriteBatchStream(stream);
      inodePaths.push(decoded.inodes.map((inode) => inode.path));
      for await (const _chunk of decoded.chunkIter) {
        // Drain the W7 v1 trailer before returning the injected result.
      }
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
      return tarball.slice();
    },
    async writeBatchStream(stream) {
      const decoded = await decodeWriteBatchStream(stream);
      successfulWaves.push(decoded.inodes.map((inode) => inode.path));
      let chunks = 0;
      for await (const _chunk of decoded.chunkIter) chunks++;
      return {
        ok: true,
        committedGroupSequence: decoded.inodes.length,
        committedPathCount: decoded.inodes.length,
        inodes: decoded.inodes.length,
        chunks,
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
}

console.log('npm shared write wave ownership: ok');
