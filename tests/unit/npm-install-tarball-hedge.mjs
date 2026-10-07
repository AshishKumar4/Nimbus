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


// ── tar fixture ─────────────────────────────────────────────────────────

function makeTarball() {
  return packageTarball({
    'package/package.json': '{"name":"left-pad","version":"1.3.0"}',
    'package/index.js': 'export default 1;',
  });
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

// ── 4. A cache write-back the transport never answers does not hold the install
//
// The write-back is best-effort. An RPC dropped without a word (the way
// writeBatchStream calls were, 2026-09-28) never settles, and the package
// waited on it until the batch deadline. Timers run a thousand times faster
// here, so the write's own deadline passes in milliseconds; an install that
// never settles fails the case instead of hanging the suite.
{
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.ceil((ms ?? 0) / 1000), ...rest);
  let writes = 0;
  let result;
  try {
    result = await Promise.race([
      install({ ...supervisorFor(null), putCachedTarball: () => { writes++; return new Promise(() => {}); } }),
      new Promise((_, reject) => realSetTimeout(
        () => reject(new Error('the install never settled: it waited on the unanswered cache write')),
        5_000,
      )),
    ]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(writes, 1, 'the registry tarball is offered to the cache');
  assert.ok(!result.perPackage[0].errorText, result.perPackage[0].errorText);
  console.log('  case4: an unanswered cache write-back is abandoned and the install completes');
}

globalThis.fetch = originalFetch;
console.log('npm-install-tarball-hedge: ok');
