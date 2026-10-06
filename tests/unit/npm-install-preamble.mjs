#!/usr/bin/env bun
/**
 * The install facet's preamble (loaders/npm-install-preamble.ts) carries the
 * registry retry policy and tarball integrity by their own source. Evaluated
 * as the facet evaluates it, each embedded function answers as the module's:
 *   - retryingRegistryFetch retries a 5xx and a request that never answered,
 *     returns a 4xx at once, and gives up after three re-tries, and the
 *     supervisor's packument fetch (r2-cache.ts) answers by the same policy,
 *     a body that breaks off mid-read included (a failure, never a throw);
 *   - an install checks the strongest entry of a multi-hash SRI string, as
 *     npm's ssri does, and refuses an entry of an algorithm it checks whose
 *     digest is not that algorithm's (empty, not base64, the wrong length);
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

// The network every try goes through: the isolate's own fetch, at call time.
const ISOLATE = { fetch: (input, init) => globalThis.fetch(input, init) };
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
      fetchOnce: async (_fetch, n) => {
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
    const response = await embedded.retryingRegistryFetch(ISOLATE, fetchOnce, {
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
    assert.equal((await embedded.retryingRegistryFetch(ISOLATE, fetchOnce)).status, 404, 'a 4xx is the answer');
    assert.deepEqual(calls, [0]);
  }
  {
    const { calls, fetchOnce } = answers(502);
    assert.equal((await embedded.retryingRegistryFetch(ISOLATE, fetchOnce)).status, 502, 'the last 5xx once the re-tries are spent');
    assert.equal(calls.length, 4);
  }
  {
    const { fetchOnce } = answers('throw');
    await assert.rejects(embedded.retryingRegistryFetch(ISOLATE, fetchOnce, { retries: 1 }), /socket hang up/);
  }
  {
    // Every try fetches through the network it was given.
    const through = [];
    const network = { fetch: async (url) => { through.push(String(url)); return new Response('x', { status: through.length < 2 ? 503 : 200 }); } };
    const response = await embedded.retryingRegistryFetch(network, (fetch, n) => fetch(`https://registry.invalid/p?try=${n}`));
    assert.equal(response.status, 200);
    assert.deepEqual(through, ['https://registry.invalid/p?try=0', 'https://registry.invalid/p?try=1']);
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
      if (status === 'broken') {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"na'));
            controller.error(new TypeError('connection reset'));
          },
        }), { status: 200 });
      }
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
    assert.deepEqual(await read('broken', 200), { calls: 2, json: '{"name":"p"}', status: undefined, failure: undefined },
      'a 200 whose body breaks off is tried again');
    assert.deepEqual(await read('broken'), { calls: 4, json: null, status: undefined, failure: 'connection reset' },
      'and fails, never throws, once the re-tries are spent');
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
  'with options': `sha512-${sha512}?opt`,
  'malformed digest': 'sha512-not!base64!',
  'empty digest': 'sha512-',
  'empty strongest beside a matching weaker one': `sha512- sha1-${sha1}`,
  'wrong length': `sha512-${sha1}`,
};
const refused = (read) => { try { return read(); } catch (e) { return `refused: ${e.message}`; } };
for (const [label, sri] of Object.entries(cases)) {
  const mine = refused(() => integrity.strongestSriEntry(sri));
  assert.deepEqual(refused(() => embedded.strongestSriEntry(sri)), mine, label);
  if (typeof mine === 'string') continue;
  if (mine) {
    const got = await embedded.sriDigestOf(bytes, mine.digestAlgo);
    assert.equal(got, await integrity.sriDigestOf(bytes, mine.digestAlgo));
    assert.equal(embedded.sriDigestsEqual(got, mine.digest), integrity.sriDigestsEqual(got, mine.digest), label);
  }
}
const installs = async (sri) => {
  const entry = refused(() => integrity.strongestSriEntry(sri));
  if (typeof entry === 'string') return 'refused';
  return entry === null ? 'skipped' : integrity.sriDigestsEqual(await integrity.sriDigestOf(bytes, entry.digestAlgo), entry.digest);
};
assert.equal(await installs(cases.single), true);
assert.equal(await installs(cases.multi), true, 'a multi-hash string is checked by its strongest entry');
assert.equal(await installs(cases['multi, strongest wrong']), false, 'and only by it');
assert.equal(await installs(cases['unknown algorithm beside a known one']), true);
assert.equal(await installs(cases.unknown), 'skipped');
assert.equal(await installs(cases['legacy shasum']), 'skipped');
assert.equal(await installs(cases['with options']), true, 'options after ? are not the digest');
for (const label of ['malformed digest', 'empty digest', 'empty strongest beside a matching weaker one', 'wrong length']) {
  assert.equal(await installs(cases[label]), 'refused', `${label}: an algorithm npm checks with a digest that is not one of it`);
}

// The cache addresses one-entry strings only.
assert.ok(parseTarballAddress(cases.single));
for (const label of ['multi', 'unknown', 'legacy shasum', 'malformed digest', 'empty digest', 'wrong length']) {
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
