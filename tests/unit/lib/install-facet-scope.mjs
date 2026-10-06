/**
 * The names the install facet (packages/worker/src/npm/install-batch-facet.ts)
 * finds in its scope, set on globalThis as the pool's preamble declares them
 * in production: the tar stream primitives, the W7 encoder, the wave writer,
 * the RPC-result helper, and the install preamble's functions, evaluated
 * from their embedded source (loaders/npm-install-preamble.ts). Plus a gzip
 * DecompressionStream over node:zlib, which Bun lacks for this use.
 *
 * Import it for its effect, before calling installPackagesInFacet.
 */

import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import {
  readableStreamToAsyncIterable,
  streamPackageEntries,
  streamTarEntries,
} from '../../../packages/core/src/_shared/tarball-stream.ts';
import { encodeWriteBatchStream } from '../../../packages/platform/src/w7-frame.ts';
import { NPM_INSTALL_PREAMBLE } from '../../../packages/worker/src/loaders/npm-install-preamble.ts';

globalThis.streamPackageEntries = streamPackageEntries;
globalThis.streamTarEntries = streamTarEntries;
globalThis.readableStreamToAsyncIterable = readableStreamToAsyncIterable;
globalThis.encodeWriteBatchStream = encodeWriteBatchStream;
globalThis.__nimbusWaveWriter = await import('../../../packages/platform/src/wave-writer.ts');
globalThis.__nimbusUseRpcResult = async (promise, use) => use(await promise);
Object.assign(globalThis, new Function(`${NPM_INSTALL_PREAMBLE}
return { retryingRegistryFetch, strongestSriEntry, sriDigestOf, sriDigestsEqual };`)());

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
