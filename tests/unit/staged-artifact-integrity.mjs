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
import { fetchNodeFacetSources } from '../../packages/worker/src/runtime/node-shims-artifact.ts';
import {
  NODE_SHIMS_ENTRY,
  RESIDENT_STORE_ENTRY,
  VFS_WRITE_LEDGER_ENTRY,
} from '../../packages/worker/src/node-shims-artifact.generated.ts';

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/worker',
);

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

  // The node-compat layer's three sources arrive in one per-isolate fetch.
  // Each is verified on its own: poisoning any one of them, on either tier,
  // is a throw that names it, never a facet spliced from attacker text.
  // Failed fetches are not memoized, so the clean fetch comes last.
  const nodeSources = [
    ['node-shims', NODE_SHIMS_ENTRY, 'shims'],
    ['vfs-write-ledger', VFS_WRITE_LEDGER_ENTRY, 'ledger'],
    ['resident-store', RESIDENT_STORE_ENTRY, 'residentStore'],
  ];
  const stagedText = (entry) => readFileSync(path.join(workerRoot, 'public', entry.slice(1)), 'utf8');
  const nodeAssets = (poisoned) => ({
    ASSETS: {
      async fetch(request) {
        const entry = new URL(request.url).pathname;
        return new Response(entry === poisoned ? POISON : stagedText(entry));
      },
    },
  });
  /** caches.default serving POISON for `poisoned`'s entry, a miss for the rest. */
  const nodeCaches = (poisoned) => {
    const puts = [];
    globalThis.caches = {
      default: {
        async match(request) {
          return poisoned !== null && new URL(request.url).pathname === poisoned ? new Response(POISON) : undefined;
        },
        async put(request, response) {
          puts.push(request.url);
          await response.text();
        },
      },
    };
    return puts;
  };
  for (const [label, entry] of nodeSources) {
    nodeCaches(entry);
    await rejects(() => fetchNodeFacetSources(nodeAssets(null)), new RegExp(`${label} asset integrity mismatch`),
      `${label}: poisoned L2 entry`);
    nodeCaches(null);
    await rejects(() => fetchNodeFacetSources(nodeAssets(entry)), new RegExp(`${label} asset integrity mismatch`),
      `${label}: poisoned ASSETS read`);
  }
  const nodePuts = nodeCaches(null);
  const fetched = await fetchNodeFacetSources(nodeAssets(null));
  for (const [label, entry, field] of nodeSources) {
    assert.equal(fetched[field], stagedText(entry), `${label}: the facet gets the staged source`);
  }
  assert.equal(new Set(nodePuts).size, nodeSources.length, 'each source is written back to L2 under its own key');
} finally {
  delete globalThis.caches;
}

console.log(
  `staged-artifact-integrity OK: ${cases.length} readers and the node-compat sources reject poisoned ` +
    `L2 + ASSETS bytes; ${Object.keys(OPENCODE_ARTIFACT_DIGESTS).length} opencode files pinned`,
);
