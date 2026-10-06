#!/usr/bin/env bun
/**
 * The install facet's preamble (loaders/npm-install-preamble.ts) carries the
 * registry retry policy and tarball integrity by their own source. Evaluated
 * as the facet evaluates it, each embedded function answers as the module's:
 *   - retryingRegistryFetch retries a 5xx and a request that never answered,
 *     returns a 4xx at once, and gives up after three re-tries, and the
 *     supervisor's packument fetch (r2-cache.ts) answers by the same policy;
 *   - an install checks the strongest entry of a multi-hash SRI string, as
 *     npm's ssri does, and refuses a digest that does not decode;
 *   - the shared cache addresses only a one-entry string.
 * And bundled as the Worker bundles it (esbuild), the module the install
 * facet's loader worker parses reads no name it leaves undefined: the
 * bundler renames a declaration a module names as a global
 * (`retryingRegistryFetch2`), so the facet must name what its preamble
 * defines by the same identifier.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { assembleLoaderWorkerModuleSource } from '../../packages/fabric/src/isolate-pool.ts';
import { serializeFunction } from '../../packages/fabric/src/vendor/serialize.ts';
import { parseJavaScriptModule } from '../../packages/core/src/runtime/javascript-ast.ts';
import { bindingScope, namesBinding, scoped } from '../../packages/core/src/runtime/javascript-scope.ts';
import { NPM_INSTALL_PREAMBLE } from '../../packages/worker/src/loaders/npm-install-preamble.ts';
import { R2CacheClient, parseTarballAddress } from '../../packages/worker/src/npm/r2-cache.ts';
import * as integrity from '../../packages/core/src/_shared/tarball-integrity.ts';

const embedded = new Function(`${NPM_INSTALL_PREAMBLE}
return { retryingRegistryFetch, strongestSriEntry, sriEntries, sriDigestOf, sriDigestsEqual };`)();

// The schedule is shortened for the test; the policy is the preamble's.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);
try {
  const answers = (...statuses) => {
    const calls = [];
    return {
      calls,
      fetchOnce: async (n) => {
        calls.push(n);
        const status = statuses[Math.min(n, statuses.length - 1)];
        if (status === 'throw') throw Object.assign(new Error('socket hang up'), { name: 'TypeError' });
        if (status === 'abort') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return new Response('x', { status });
      },
    };
  };
  {
    const { calls, fetchOnce } = answers(503, 'throw', 'abort', 200);
    const heard = [];
    const waits = [];
    const response = await embedded.retryingRegistryFetch(fetchOnce, {
      onRetry: (retry, of, ms, reason) => { heard.push(`${retry}/${of} ${reason}`); waits.push(ms); },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [0, 1, 2, 3]);
    assert.deepEqual(heard, ['1/3 HTTP 503', '2/3 socket hang up', '3/3 timeout']);
    // 500, 1500 and 4500 ms apart, each ±25%.
    [500, 1500, 4500].forEach((base, i) => assert.ok(waits[i] >= base * 0.75 && waits[i] <= base * 1.25, `wait ${i}: ${waits[i]}`));
  }
  {
    const { calls, fetchOnce } = answers(404);
    assert.equal((await embedded.retryingRegistryFetch(fetchOnce)).status, 404, 'a 4xx is the answer');
    assert.deepEqual(calls, [0]);
  }
  {
    const { calls, fetchOnce } = answers(502);
    assert.equal((await embedded.retryingRegistryFetch(fetchOnce)).status, 502, 'the last 5xx once the re-tries are spent');
    assert.equal(calls.length, 4);
  }
  {
    const { fetchOnce } = answers('throw');
    await assert.rejects(embedded.retryingRegistryFetch(fetchOnce, { retries: 1 }), /socket hang up/);
  }
  // The supervisor's packument fetch, under the same policy.
  const originalFetch = globalThis.fetch;
  const read = async (...statuses) => {
    const queue = [...statuses];
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      const status = queue.length > 1 ? queue.shift() : queue[0];
      if (status === 'throw') throw new Error('socket hang up');
      return new Response(status === 200 ? '{"name":"p"}' : 'x', { status });
    };
    const empty = { async get() { return null; }, async put() {}, async delete() {} };
    const result = await new R2CacheClient(empty, null).readThroughPackument('p');
    return { calls, json: result.json, status: result.status, failure: result.failure };
  };
  try {
    assert.deepEqual(await read(503, 'throw', 200), { calls: 3, json: '{"name":"p"}', status: undefined, failure: undefined });
    assert.deepEqual(await read(404), { calls: 1, json: null, status: 404, failure: undefined });
    assert.deepEqual(await read(503), { calls: 4, json: null, status: undefined, failure: 'HTTP 503' });
    assert.deepEqual(await read('throw'), { calls: 4, json: null, status: undefined, failure: 'socket hang up' });
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  globalThis.setTimeout = realSetTimeout;
}

// Integrity, embedded and imported alike.
const bytes = new TextEncoder().encode('tarball bytes');
const sha512 = await integrity.sriDigestOf(bytes, 'SHA-512');
const sha1 = await integrity.sriDigestOf(bytes, 'SHA-1');
const cases = {
  single: `sha512-${sha512}`,
  multi: `sha1-${btoa('wrong digest bytes!!')} sha512-${sha512}`,
  'multi, strongest wrong': `sha512-${btoa('x'.repeat(64))} sha1-${sha1}`,
  'unknown algorithm beside a known one': `md5-abc sha1-${sha1}`,
  unknown: 'md5-abc',
  'legacy shasum': 'deadbeef',
  'malformed digest': 'sha512-not!base64!',
};
for (const [label, sri] of Object.entries(cases)) {
  const mine = integrity.strongestSriEntry(sri);
  assert.deepEqual(embedded.strongestSriEntry(sri), mine, label);
  if (mine) {
    const got = await embedded.sriDigestOf(bytes, mine.digestAlgo);
    assert.equal(got, await integrity.sriDigestOf(bytes, mine.digestAlgo));
    assert.equal(embedded.sriDigestsEqual(got, mine.digest), integrity.sriDigestsEqual(got, mine.digest), label);
  }
}
const installs = async (sri) => {
  const entry = integrity.strongestSriEntry(sri);
  return entry === null ? 'skipped' : integrity.sriDigestsEqual(await integrity.sriDigestOf(bytes, entry.digestAlgo), entry.digest);
};
assert.equal(await installs(cases.single), true);
assert.equal(await installs(cases.multi), true, 'a multi-hash string is checked by its strongest entry');
assert.equal(await installs(cases['multi, strongest wrong']), false, 'and only by it');
assert.equal(await installs(cases['unknown algorithm beside a known one']), true);
assert.equal(await installs(cases.unknown), 'skipped');
assert.equal(await installs(cases['legacy shasum']), 'skipped');
assert.equal(await installs(cases['malformed digest']), false, 'a known algorithm with a digest that does not decode never matches');

// The cache addresses one-entry strings only.
assert.ok(parseTarballAddress(cases.single));
for (const label of ['multi', 'unknown', 'legacy shasum', 'malformed digest']) {
  assert.equal(parseTarballAddress(cases[label]), null, `the cache does not address ${label}`);
}


// Bundled as the Worker bundles it, then assembled as the isolate pool
// assembles the install facet's loader worker (installer.ts's preamble):
// every name the module reads that it does not bind is a runtime global.
{
  const root = new URL('../../', import.meta.url).pathname;
  const bundled = await esbuild.build({
    stdin: {
      contents: [
        "export { NPM_INSTALL_PREAMBLE } from './packages/worker/src/loaders/npm-install-preamble.ts';",
        "export { TAR_STREAM_PREAMBLE, W7_FRAME_PREAMBLE, WAVE_WRITER_PREAMBLE } from './packages/worker/src/loaders/generated-workers.ts';",
        "export { installPackagesInFacet } from './packages/worker/src/npm/install-batch-facet.ts';",
      ].join('\n'),
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], write: false, logLevel: 'silent',
  });
  const dir = mkdtempSync(join(tmpdir(), 'install-facet-bundle-'));
  try {
    writeFileSync(join(dir, 'bundle.mjs'), bundled.outputFiles[0].text);
    const worker = await import(join(dir, 'bundle.mjs'));
    const source = assembleLoaderWorkerModuleSource({
      fnSource: serializeFunction(worker.installPackagesInFacet),
      preamble: [worker.TAR_STREAM_PREAMBLE, worker.W7_FRAME_PREAMBLE, worker.WAVE_WRITER_PREAMBLE, worker.NPM_INSTALL_PREAMBLE].join('\n'),
      hasBindings: true,
    });
    const free = new Set();
    const outside = { names: new Set(), parent: null };
    for (const [node, scope, parent, key] of scoped(parseJavaScriptModule(source), outside, false)) {
      if (node.type === 'Identifier' && parent !== null && namesBinding(parent, key) && bindingScope(scope, node.name) === null) free.add(node.name);
    }
    assert.deepEqual([...free].filter((name) => !(name in globalThis)), [], 'the bundled install facet reads only names its module or the runtime defines');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('npm-install-preamble: ok');
