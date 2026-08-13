#!/usr/bin/env bun

// The install facet resolves each tarball from two places: the shared R2
// cache via the supervisor, and the registry over the network. Issuing both
// at once made a cache hit — the common case on a warm install — pay for a
// registry request it immediately threw away, and a one-package warm install
// went from ~103 ms to ~303 ms.
//
// The network leg is a hedge instead: armed only once the R2 leg has failed
// to answer within the speculation delay, which is the only window in which
// the bounded R2 wait would otherwise be dead air.
//
// These tests pin that as behaviour of installPackagesInFacet, counting
// requests at the real external seam (globalThis.fetch):
//
//   1. An R2 hit installs without touching the registry at all.
//   2. An R2 miss still installs, from the registry.
//   3. A stalled R2 leg is overlapped — the hedge fires and the install
//      completes from the registry rather than waiting out the full bound.

import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import {
  readableStreamToAsyncIterable,
  streamTarEntries,
} from '../../packages/core/src/_shared/tarball-stream.ts';
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

// ── tar fixture ─────────────────────────────────────────────────────────

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
    ...tarFile('package/package.json', '{"name":"left-pad","version":"1.3.0"}'),
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

async function sriOf(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));
  let bin = '';
  for (const byte of digest) bin += String.fromCharCode(byte);
  return `sha512-${btoa(bin)}`;
}

const TARBALL = makeTarball();
const SRI = await sriOf(TARBALL);
const TARBALL_URL = 'https://registry.invalid/left-pad-1.3.0.tgz';

// ── harness ─────────────────────────────────────────────────────────────

/**
 * @param cached  bytes the R2 leg returns, or null for a miss.
 * @param delayMs how long the R2 leg takes to answer.
 */
function supervisorFor(cached, delayMs = 0) {
  return {
    async writeBatchStream(stream) {
      const decoded = await decodeWriteBatchStream(stream);
      let paths = 0;
      for await (const record of decoded.records) {
        if (record.type === 'directory' || record.type === 'file-begin') paths++;
        if (record.type === 'file-chunk') record.retention.release();
      }
      return {
        ok: true,
        committedGroupSequence: paths,
        committedPathCount: paths,
        inodes: paths,
        chunks: 0,
      };
    },
    async getCachedTarball() {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return { bytes: cached, events: [] };
    },
    async putCachedTarball() { /* write-back is not under test */ },
  };
}

const spec = {
  name: 'left-pad',
  version: '1.3.0',
  tarballUrl: TARBALL_URL,
  integrity: SRI,
  pkgDir: 'node_modules/left-pad',
  installRoot: 'node_modules',
  mtime: 1,
  chunkSize: 65_536,
};

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  return new Response(TARBALL.slice(), {
    status: 200,
    headers: { 'content-length': String(TARBALL.length) },
  });
};

async function install(supervisor) {
  fetchCalls = 0;
  const result = await installPackagesInFacet(
    { packages: [spec], concurrency: 1 },
    { SUPERVISOR: supervisor },
  );
  return result;
}

// ── 1. A cache hit never reaches the registry ───────────────────────────
{
  const result = await install(supervisorFor(TARBALL));
  assert.ok(!result.perPackage[0].errorText, result.perPackage[0].errorText);
  assert.equal(fetchCalls, 0, 'an R2 hit issues no registry request');
  assert.equal(
    result.facetCounters.speculativeFetches,
    0,
    'and reports that it armed no hedge',
  );
  assert.equal(result.facetCounters.pipelinedTarballRaceWins, 1);
  console.log('  case1: R2 hit installs with zero registry requests');
}

// ── 2. A cache miss still installs, from the registry ───────────────────
{
  const result = await install(supervisorFor(null));
  assert.ok(!result.perPackage[0].errorText, result.perPackage[0].errorText);
  assert.equal(fetchCalls, 1, 'an R2 miss falls through to exactly one fetch');
  assert.equal(
    result.facetCounters.speculativeFetches,
    0,
    "a prompt miss answers before the hedge arms, so the fetch is the retry loop's own",
  );
  console.log('  case2: R2 miss installs from the registry');
}

// ── 3. A stalled R2 leg is overlapped by the hedge ──────────────────────
//
// The leg answers well past the speculation delay, so the download must
// already be under way when it finally reports its miss.
{
  const result = await install(supervisorFor(null, 200));
  assert.ok(!result.perPackage[0].errorText, result.perPackage[0].errorText);
  assert.equal(fetchCalls, 1, 'the hedge is the fetch, not an extra one');
  assert.equal(
    result.facetCounters.speculativeFetches,
    1,
    'a stalled R2 leg arms the hedge',
  );
  assert.ok(
    result.facetCounters.r2WaitMsMax >= 200,
    `stall is reported (r2WaitMsMax=${result.facetCounters.r2WaitMsMax})`,
  );
  console.log('  case3: stalled R2 leg arms the hedge and still installs');
}

globalThis.fetch = originalFetch;
console.log('npm-install-tarball-hedge: ok');
