#!/usr/bin/env bun
// An install's tarball downloads never sit open and unread, so the runtime's
// connection limit never closes one under it.
//
// workerd lets an invocation hold six connections open; a seventh waits, and
// if every open one is idle (an answer whose body nobody is reading) the
// least recently used is closed: reading its body then fails "Response closed
// due to connection limit". The install facet held registry answers open
// unread: a hedge's answer while the R2 leg was still out, and a body read
// only as fast as the package's files were written. Under a full batch one
// package in about ten failed so (pi's official installer, 14 of 153 probe
// runs; every failure's reason was this error).
//
// Driven through installPackagesInFacet with the registry at the real seam
// (globalThis.fetch) answering as workerd does at its limit: six open, LRU
// idle closed when another must wait. Eight packages at the batch's top
// concurrency: (1) the R2 leg answering a miss after the hedge has fired;
// (2) no R2 leg and no integrity, with a slow writer. And an answer that is
// not a tarball keeps only its status: (3) a 503 whose body never comes is
// retried, not waited on; (4) a 404 whose body has failed is the 404, asked
// once. (5) Every registry request the installer retries (its packuments
// too) answers so: a 2xx's body read before anyone reads it, any other's
// cancelled.
//
// Red before: the hedged answers sat unread until R2 answered; one was closed,
// and its package failed with the runtime's error.

import assert from 'node:assert/strict';
import { installPackagesInFacet } from '../../packages/worker/src/npm/install-batch-facet.ts';
import { retryingRegistryFetch } from '../../packages/worker/src/npm/registry-retry.ts';
import { decodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { packageTarball, sriOf } from './lib/tarball-fixture.mjs';
import './lib/install-facet-scope.mjs';

const LIMIT = 6;
const CLOSED = 'Response closed due to connection limit';

/**
 * The registry as an invocation at workerd's connection limit sees it: six
 * connections open at most; while another waits, if no open one has seen a
 * read for IDLE_MS (none is being read), the least recently read is closed.
 */
const IDLE_MS = 10;
function limitedRegistry(tarballs) {
  const open = new Set();
  const waiting = [];
  let closed = 0;
  const release = (connection) => {
    if (!open.delete(connection)) return;
    const next = waiting.shift();
    if (next) next();
  };
  const watch = () => {
    if (waiting.length === 0) return;
    const now = performance.now();
    const all = [...open];
    if (all.length >= LIMIT && all.every((connection) => !connection.reading && now - connection.usedAt >= IDLE_MS)) {
      closed += 1;
      all.sort((a, b) => a.usedAt - b.usedAt)[0].close();
    }
    setTimeout(watch, 2);
  };
  const fetch = async (url, init) => {
    if (open.size >= LIMIT) {
      const turn = new Promise((resolve) => { waiting.push(resolve); });
      if (waiting.length === 1) setTimeout(watch, 2);
      await turn;
    }
    const bytes = tarballs.get(String(url));
    let offset = 0;
    let controllerRef = null;
    const connection = {
      reading: false,
      usedAt: performance.now(),
      close() {
        controllerRef?.error(new Error(CLOSED));
        release(connection);
      },
    };
    open.add(connection);
    init?.signal?.addEventListener('abort', () => connection.close(), { once: true });
    const body = new ReadableStream({
      start(controller) { controllerRef = controller; },
      async pull(controller) {
        connection.reading = true;
        await new Promise((resolve) => setTimeout(resolve, 1));
        connection.reading = false;
        connection.usedAt = performance.now();
        if (!open.has(connection)) return;
        if (offset >= bytes.length) {
          controller.close();
          release(connection);
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 4096));
        offset += 4096;
      },
      cancel() { release(connection); },
    }, { highWaterMark: 0 });
    // The answer's headers arrive; what comes after is read only as its reader pulls.
    return new Response(body, { status: 200 });
  };
  return { fetch, closed: () => closed };
}

const specs = [];
const tarballs = new Map();
for (let i = 0; i < 8; i++) {
  const name = `pkg-${i}`;
  const files = { 'package/package.json': JSON.stringify({ name, version: '1.0.0' }) };
  // Bodies of a few chunks each, as small registry tarballs are.
  for (let f = 0; f < 4; f++) files[`package/lib/f${f}.js`] = `module.exports = ${JSON.stringify('x'.repeat(3000) + i + f)};\n`;
  const tarball = packageTarball(files);
  const url = `https://registry.invalid/${name}-1.0.0.tgz`;
  tarballs.set(url, tarball);
  specs.push({ name, version: '1.0.0', tarballUrl: url, integrity: await sriOf(tarball), pkgDir: `node_modules/${name}`, installRoot: 'node_modules', mtime: 1, chunkSize: 65_536 });
}

const writeAll = async (stream, delayMs) => {
  const decoded = await decodeWriteBatchStream(stream);
  let paths = 0;
  for await (const record of decoded.records) {
    if (record.type === 'directory' || record.type === 'file-begin') paths++;
    if (record.type === 'file-chunk') record.retention.release();
  }
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return { ok: true, committedGroupSequence: paths, committedPathCount: paths, inodes: paths, chunks: 0 };
};
const originalFetch = globalThis.fetch;
const run = async (registry, supervisor, packages) => {
  globalThis.fetch = registry.fetch;
  try {
    return await installPackagesInFacet({ packages, concurrency: 8 }, { SUPERVISOR: supervisor });
  } finally {
    globalThis.fetch = originalFetch;
  }
};
const failures = (result) => result.perPackage.filter((r) => r.errorText).map((r) => `${r.name}: ${r.errorText}`);

// ── 1. hedged downloads, the R2 leg answering a miss after they fired ───
{
  const registry = limitedRegistry(tarballs);
  const result = await run(registry, {
    writeBatchStream: (stream) => writeAll(stream, 0),
    // A miss, answered after the hedge has fired (75 ms) and inside the bound (300 ms).
    async getCachedTarball() {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { bytes: null, events: [] };
    },
    async putCachedTarball() {},
  }, specs);
  assert.deepEqual(failures(result), [], 'every package installs');
  assert.equal(registry.closed(), 0, 'the runtime closed no download under the install');
  assert.equal(result.facetCounters.speculativeFetches, 8, 'each download was the hedge');
  console.log('  [1] hedged downloads are read as they arrive');
}

// ── 2. no R2 leg, no integrity, a slow writer ───────────────────────────
{
  const registry = limitedRegistry(tarballs);
  const result = await run(registry, { writeBatchStream: (stream) => writeAll(stream, 40) }, specs.map((spec) => ({ ...spec, integrity: '' })));
  assert.deepEqual(failures(result), [], 'every package installs');
  assert.equal(registry.closed(), 0, 'the runtime closed no download under the install');
  console.log('  [2] no R2 leg, no integrity, a slow writer');
}

// ── 3. a 503 whose body never comes is retried, not waited on ───────────
{
  let answers = 0;
  const flaky = {
    fetch: async (url) => {
      answers += 1;
      if (answers === 1) return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { status: 503 });
      return new Response(tarballs.get(String(url)).slice(), { status: 200 });
    },
  };
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.ceil((ms ?? 0) / 100), ...rest);
  let result;
  try {
    result = await Promise.race([
      run(flaky, { writeBatchStream: (stream) => writeAll(stream, 0) }, [specs[0]]),
      new Promise((_, reject) => realSetTimeout(() => reject(new Error('the install waited on the 503\'s body')), 10_000)),
    ]);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.deepEqual(failures(result), [], 'the retry installs it');
  assert.equal(answers, 2, 'after one retry');
  console.log('  [3] a 503 is retried without its body');
}
// ── 4. a 404 whose body has failed is the 404, asked once ───────────────
{
  let answers = 0;
  const broken = {
    fetch: async () => {
      answers += 1;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('the body broke')); } }), { status: 404 });
    },
  };
  const result = await run(broken, { writeBatchStream: (stream) => writeAll(stream, 0) }, [specs[0]]);
  assert.deepEqual(failures(result), ['pkg-0: HTTP 404'], 'the package fails with its status');
  assert.equal(answers, 1, 'a 4xx is not asked again');
  console.log('  [4] a 404 with a failed body is the 404, asked once');
}
// ── 5. every registry answer through the retry path is settled ──────────
{
  const network = { fetch: async () => { throw new Error('unused'); } };
  let cancelled = false;
  const missing = await retryingRegistryFetch(network, async () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; },
  }), { status: 404, statusText: 'Not Found' }));
  assert.deepEqual([missing.status, missing.statusText, missing.body, cancelled], [404, 'Not Found', null, true], 'a 404 keeps its status, its body cancelled');
  let pulled = 0;
  const chunks = 5;
  const found = await retryingRegistryFetch(network, async () => new Response(new ReadableStream({
    pull(controller) {
      pulled += 1;
      if (pulled > chunks) controller.close();
      else controller.enqueue(new Uint8Array(1024));
    },
  }, { highWaterMark: 0 }), { status: 200 }));
  for (let i = 0; i < 20 && pulled <= chunks; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(pulled, chunks + 1, 'a 200 is read to its end before anyone reads it');
  assert.equal((await found.arrayBuffer()).byteLength, chunks * 1024, 'and gives what it read');
  console.log('  [5] the retry path settles every answer');
}
console.log('npm-install-connection-limit: ok');
