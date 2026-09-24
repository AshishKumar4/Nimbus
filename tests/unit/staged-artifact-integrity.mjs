#!/usr/bin/env bun
// Integrity guard for the staged build artifacts the supervisor compiles as
// wasm modules or evaluates as facet code: the esbuild wasm, its JS adapter
// and the `esbuild` command's runner, the sql.js wasm, and every file of the
// opencode artifact.
//
// The L2 tier (caches.default) is the untrusted one — a poisoned colo-cache
// entry is served ahead of ASSETS and never re-derived from the deploy — so
// each case poisons a tier and asserts the fetch THROWS rather than handing
// attacker bytes to workerd's loader. The ASSETS tier is covered too, and the
// clean path must still return the staged bytes unchanged.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ESBUILD_VERSION,
  SQLJS_VERSION,
} from '../../packages/core/src/constants.ts';
import {
  OPENCODE_ARTIFACT_BUILD_ID,
  OPENCODE_ARTIFACT_DIGESTS,
  OPENCODE_ARTIFACT_VERSION,
} from '../../packages/worker/src/opencode-artifact.generated.ts';
import {
  ESBUILD_CLI_L2_KEY,
  ESBUILD_JS_L2_KEY,
  ESBUILD_WASM_L2_KEY,
  fetchEsbuildCliRunner,
  fetchEsbuildJsFnBody,
  fetchEsbuildWasmBytes,
} from '../../packages/worker/src/runtime/esbuild-wasm-bytes.ts';
import { ESBUILD_CLI_ASSET_PATH } from '../../packages/worker/src/esbuild-cli-artifact.generated.ts';
import {
  SQLITE_WASM_L2_KEY,
  fetchSqliteWasmBytes,
} from '../../packages/worker/src/runtime/sqlite-wasm-bytes.ts';
import { fetchOpencodeWasmBytes } from '../../packages/worker/src/runtime/opencode-artifact.ts';
import {
  NODE_SHIMS_ENTRY,
  RESIDENT_STORE_ENTRY,
  VFS_WRITE_LEDGER_ENTRY,
} from '../../packages/worker/src/node-shims-artifact.generated.ts';

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/worker',
);

// Imported per case, so each case gets its own memo (tests below).
const NODE_FETCHER = '../../packages/worker/src/runtime/node-shims-artifact.ts';

const POISON = new TextEncoder().encode('attacker-controlled bytes');

/** Installs a caches.default that serves `served` for `key` (null = miss). */
function stubCaches(key, served) {
  const puts = [];
  globalThis.caches = {
    default: {
      async match(request) {
        return served !== null && request.url === key ? new Response(served) : undefined;
      },
      async put(request, response) {
        puts.push(request.url);
        await response.arrayBuffer();
      },
    },
  };
  return puts;
}

function stubAssets(served) {
  return {
    ASSETS: {
      async fetch() {
        return served === null
          ? new Response('not found', { status: 404 })
          : new Response(served);
      },
    },
  };
}

async function rejects(fn, match, what) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, `${what}: expected a throw, got a resolved value`);
  assert.match(String(threw && threw.message), match, `${what}: wrong error`);
}

const cases = [
  {
    label: 'esbuild wasm',
    l2Key: ESBUILD_WASM_L2_KEY,
    asset: path.join(workerRoot, 'public', '_assets', `esbuild-${ESBUILD_VERSION}.wasm`),
    fetch: (env) => fetchEsbuildWasmBytes(env),
  },
  {
    // The adapter is evaluated as facet code, so it is pinned like the wasm.
    label: 'esbuild JS adapter',
    l2Key: ESBUILD_JS_L2_KEY,
    asset: path.join(workerRoot, 'public', '_assets', `esbuild-${ESBUILD_VERSION}.js`),
    fetch: async (env) => new TextEncoder().encode(await fetchEsbuildJsFnBody(env)),
  },
  {
    // Evaluated in the esbuild facet at startup, so pinned the same way.
    label: 'esbuild CLI runner',
    l2Key: ESBUILD_CLI_L2_KEY,
    asset: path.join(workerRoot, 'public', ESBUILD_CLI_ASSET_PATH),
    fetch: async (env) => new TextEncoder().encode(await fetchEsbuildCliRunner(env)),
  },
  {
    label: 'sql.js wasm',
    l2Key: SQLITE_WASM_L2_KEY,
    asset: path.join(workerRoot, 'public', '_assets', `sqljs-${SQLJS_VERSION}.wasm`),
    fetch: (env) => fetchSqliteWasmBytes(env),
  },
  {
    label: 'opencode yoga.wasm',
    l2Key:
      `https://nimbus-cache.invalid/_assets/opencode/${OPENCODE_ARTIFACT_VERSION}/` +
      `${OPENCODE_ARTIFACT_BUILD_ID}/yoga.wasm`,
    asset: path.join(
      workerRoot,
      'public',
      '_assets',
      'opencode',
      OPENCODE_ARTIFACT_VERSION,
      'yoga.wasm',
    ),
    fetch: (env) => fetchOpencodeWasmBytes(env, 'yoga.wasm'),
  },
];

try {
  for (const c of cases) {
    const real = readFileSync(c.asset);

    // 1. Poisoned L2 entry — the tier nothing else re-checks.
    stubCaches(c.l2Key, POISON);
    await rejects(
      () => c.fetch(stubAssets(real)),
      /integrity check failed/i,
      `${c.label}: poisoned L2 entry`,
    );

    // 2. Poisoned ASSETS read, L2 cold.
    stubCaches(c.l2Key, null);
    await rejects(
      () => c.fetch(stubAssets(POISON)),
      /integrity check failed/i,
      `${c.label}: poisoned ASSETS read`,
    );

    // 3. Clean L2 hit returns the staged bytes and does not write back.
    const l2Puts = stubCaches(c.l2Key, real);
    const fromL2 = new Uint8Array(await c.fetch(stubAssets(null)));
    assert.deepEqual(fromL2, new Uint8Array(real), `${c.label}: L2 hit bytes differ`);
    assert.deepEqual(l2Puts, [], `${c.label}: an L2 hit must not write back`);

    // 4. Clean ASSETS read returns the staged bytes and populates L2.
    const assetPuts = stubCaches(c.l2Key, null);
    const fromAssets = new Uint8Array(await c.fetch(stubAssets(real)));
    assert.deepEqual(fromAssets, new Uint8Array(real), `${c.label}: ASSETS bytes differ`);
    assert.deepEqual(assetPuts, [c.l2Key], `${c.label}: ASSETS read must write back to L2`);
  }

  // An opencode file with no pinned digest is a LOUD THROW, never an unchecked
  // fetch — "no digest so skip the check" is the hole this closes.
  assert.ok(
    !Object.prototype.hasOwnProperty.call(OPENCODE_ARTIFACT_DIGESTS, 'chunk-deadbeef.js'),
    'fixture filename must not be a staged file',
  );
  stubCaches('unused', null);
  await rejects(
    () => fetchOpencodeWasmBytes(stubAssets(POISON), 'chunk-deadbeef.js'),
    /has no pinned digest/,
    'opencode: unpinned filename',
  );

  // Every file fetchAsset can be asked for is pinned — the entry bundle
  // included, which OPENCODE_ARTIFACT_FILES omits.
  for (const file of ['index.js', 'index-attach.js', 'chunks.json', 'worker.js', 'parser.worker.js']) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(OPENCODE_ARTIFACT_DIGESTS, file),
      `OPENCODE_ARTIFACT_DIGESTS is missing ${file}`,
    );
  }

  // The node-compat layer's three sources arrive in one per-isolate fetch, and
  // each is verified on its own. The colo cache here keeps what it is given,
  // as caches.default does: an entry is served to every later fetch in the
  // colo for the build, so only verified bytes may ever be put, and a bad
  // entry has to go rather than fail every node launch after it.
  const nodeSources = [
    ['node-shims', NODE_SHIMS_ENTRY, 'shims'],
    ['vfs-write-ledger', VFS_WRITE_LEDGER_ENTRY, 'ledger'],
    ['resident-store', RESIDENT_STORE_ENTRY, 'residentStore'],
  ];
  const stagedText = (entry) => readFileSync(path.join(workerRoot, 'public', entry.slice(1)), 'utf8');
  // A truncated body, as an interrupted read or a short 200 would give.
  const truncated = (entry) => stagedText(entry).slice(0, 1000);
  const nodeAssets = (bad) => ({
    ASSETS: {
      async fetch(request) {
        const entry = new URL(request.url).pathname;
        return new Response(entry === bad ? truncated(entry) : stagedText(entry));
      },
    },
  });
  const persistentCache = () => {
    const entries = new Map();
    globalThis.caches = {
      default: {
        async match(request) {
          const body = entries.get(request.url);
          return body === undefined ? undefined : new Response(body);
        },
        async put(request, response) { entries.set(request.url, await response.text()); },
        async delete(request) { return entries.delete(request.url); },
      },
    };
    return entries;
  };
  const cachedFor = (entries, entry) => [...entries].filter(([url]) => new URL(url).pathname === entry).map(([, body]) => body);
  // Each case runs in an isolate of its own: a fresh copy of the fetcher and its memo.
  let isolate = 0;
  const freshIsolate = async () => (await import(`${NODE_FETCHER}?isolate=${++isolate}`)).fetchNodeFacetSources;
  const assertServesStaged = (fetched, what) => {
    for (const [label, entry, field] of nodeSources) {
      assert.equal(fetched[field], stagedText(entry), `${what}: ${label} is the staged source`);
    }
  };
  const assertCachesOnlyStaged = (entries, what) => {
    for (const [label, entry] of nodeSources) {
      for (const body of cachedFor(entries, entry)) {
        assert.equal(body, stagedText(entry), `${what}: L2 holds bytes for ${label} that are not the staged source`);
      }
    }
  };

  for (const [label, entry] of nodeSources) {
    // A bad ASSETS body is refused and never cached: once ASSETS is sound
    // again, the same isolate's next fetch succeeds.
    {
      const entries = persistentCache();
      const fetchSources = await freshIsolate();
      await rejects(() => fetchSources(nodeAssets(entry)), new RegExp(`${label} asset integrity mismatch`),
        `${label}: truncated ASSETS body`);
      assertCachesOnlyStaged(entries, `${label}: after a truncated ASSETS body`);
      assertServesStaged(await fetchSources(nodeAssets(null)), `${label}: the retry after a truncated body`);
    }
    // A bad L2 entry is dropped and the source read from ASSETS again, and
    // the staged bytes take its place.
    {
      const entries = persistentCache();
      await (await freshIsolate())(nodeAssets(null));
      const [key] = [...entries.keys()].filter((url) => new URL(url).pathname === entry);
      assert.ok(key, `${label}: a clean fetch caches the source`);
      entries.set(key, new TextDecoder().decode(POISON));
      assertServesStaged(await (await freshIsolate())(nodeAssets(null)), `${label}: a poisoned L2 entry`);
      assertCachesOnlyStaged(entries, `${label}: after a poisoned L2 entry`);
      assert.equal(cachedFor(entries, entry).length, 1, `${label}: the staged bytes replace the poisoned entry`);
    }
    // Both tiers bad: the fetch fails and names the source, and the bad L2
    // entry is gone rather than waiting for the next fetch.
    {
      const entries = persistentCache();
      await (await freshIsolate())(nodeAssets(null));
      const [key] = [...entries.keys()].filter((url) => new URL(url).pathname === entry);
      entries.set(key, new TextDecoder().decode(POISON));
      await rejects(() => freshIsolate().then((fetchSources) => fetchSources(nodeAssets(entry))),
        new RegExp(`${label} asset integrity mismatch`), `${label}: poisoned L2 entry and truncated ASSETS body`);
      assertCachesOnlyStaged(entries, `${label}: after both tiers were bad`);
    }
  }
  {
    const entries = persistentCache();
    assertServesStaged(await (await freshIsolate())(nodeAssets(null)), 'a clean fetch');
    assert.equal(entries.size, nodeSources.length, 'each source is cached under its own key');
  }
} finally {
  delete globalThis.caches;
}

console.log(
  `staged-artifact-integrity OK: ${cases.length} readers and the node-compat sources reject poisoned ` +
    `L2 + ASSETS bytes; ${Object.keys(OPENCODE_ARTIFACT_DIGESTS).length} opencode files pinned`,
);
