#!/usr/bin/env bun
// npm-swap-alias-resolve — a registry swap is an npm alias, end to end.
//
// `npm install esbuild` used to land the package in node_modules/esbuild-wasm
// because the supervisor renamed the spec KEY to the swap target, and the
// key is what names the install directory. A swap is now expressed as the
// alias range `esbuild@npm:esbuild-wasm@<range>` (wasm-swap-registry.ts
// applySwaps), and the per-package resolver answers an alias with the
// TARGET's packument under the REQUESTED name — the one path an explicit
// user alias (`is-number-alias@npm:is-number@7`) already takes.
//
// This file pins the facet half of that contract:
//   - an alias spec fetches the target packument and materialises under the
//     alias name, and does NOT re-announce a swap (the supervisor did);
//   - a bare transitive edge to a swapped name takes the same path and
//     announces the swap once, as `ctx: 'transitive'`;
//   - a user's explicit alias to some OTHER package is authoritative, and
//     an alias to the NATIVE package still gets its target swapped: policy
//     keys on the registry identity, placement on the declared name;
//   - the cache fast-path is keyed by the install name, so a warm second
//     install answers `esbuild` with the entry the first install wrote.

import assert from 'node:assert/strict';
import { resolveOnePackumentInFacet } from '../../packages/worker/src/npm/resolve-one-facet.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../packages/worker/src/loaders/npm-resolve-preamble.ts';
import { applySwaps } from '../../packages/worker/src/facets/wasm-swap-registry.ts';

const PREAMBLE_SYMBOLS = [
  'SHOULD_SWAP', 'SHOULD_REJECT_FAIL',
  'NATIVE_EXECUTABLE_REJECT', 'NATIVE_PLATFORM_REJECT', 'NATIVE_BIN_ADVISORY', 'IS_OPTIONAL_NATIVE_BINDING',
  'PARSE_SEMVER', 'COMPARE_SEMVER', 'SATISFIES_RANGE', 'RESOLVE_VERSION',
  'STAGED_ARTIFACT', 'STAGED_ARTIFACT_APPLY',
];
Object.assign(
  globalThis,
  new Function(`${NPM_RESOLVE_PREAMBLE}\nreturn { ${PREAMBLE_SYMBOLS.join(', ')} };`)(),
);
globalThis.__nimbusUseRpcResult = async (promise, use) => use(await promise);

const spec = (overrides = {}) => ({
  name: 'esbuild',
  range: '^0.20.0',
  cachedEntries: [],
  topLevel: false,
  isOptional: false,
  frameworkAware: false,
  fetchTimeoutMs: 1_000,
  retries: 0,
  ...overrides,
});

/** A registry that serves one packument per name and records what was asked. */
const registry = (packuments) => {
  const asked = [];
  return {
    asked,
    env: {
      SUPERVISOR: {
        async getPackument(name) {
          asked.push(name);
          const json = packuments[name];
          if (!json) return { json: null, source: 'network', status: 404, events: [] };
          return { json, source: 'network', events: [] };
        },
      },
    },
  };
};

const packument = (name, versions) => JSON.stringify({
  name,
  'dist-tags': { latest: Object.keys(versions).at(-1) },
  versions: Object.fromEntries(Object.entries(versions).map(([v, extra]) => [v, {
    name, version: v,
    dist: { tarball: `https://registry.invalid/${name}/-/${name}-${v}.tgz`, integrity: `sha512-${name}-${v}` },
    ...extra,
  }])),
});

const REGISTRY = {
  'esbuild-wasm': packument('esbuild-wasm', { '0.20.0': { bin: { esbuild: 'bin/esbuild' } }, '0.20.1': { bin: { esbuild: 'bin/esbuild' } } }),
  'some-other': packument('some-other', { '1.0.0': {} }),
};

// ── Top level: the alias spec applySwaps produces ────────────────────────
{
  const { specs } = applySwaps({ esbuild: '^0.20.0' });
  const { env, asked } = registry(REGISTRY);
  const res = await resolveOnePackumentInFacet(spec({ range: specs.esbuild, topLevel: true }), env);
  assert.deepEqual(asked, ['esbuild-wasm'], 'the packument comes from the swap target');
  assert.equal(res.pkg?.name, 'esbuild', 'the package materialises under the requested name');
  assert.equal(res.pkg?.version, '0.20.1', 'the user\'s range is honoured against the target');
  assert.match(res.pkg.tarballUrl, /esbuild-wasm-0\.20\.1\.tgz$/, 'the tarball is the target\'s');
  assert.deepEqual(res.pkg.bin, { esbuild: 'bin/esbuild' }, 'the target\'s bin links under the requested name');
  assert.equal(res.error, undefined);
  assert.ok(!res.messages.some((m) => m.includes('[swap]')), `no second swap notice — the supervisor announced it (messages=${JSON.stringify(res.messages)})`);
  assert.ok(!res.events.some((e) => e.type === 'swap'), 'no second swap event');
  // Cache writes are keyed by the install name: that is the key the next
  // install's cache read uses.
  assert.ok(res.cacheWrites.length > 0);
  assert.ok(res.cacheWrites.every((w) => w.name === 'esbuild'), 'cache entries are keyed by the requested name');
  console.log('  top-level alias spec → target packument under the requested name, announced once');
}

// ── Transitive: a bare dependency edge on a swapped name ─────────────────
{
  const { env, asked } = registry(REGISTRY);
  const res = await resolveOnePackumentInFacet(spec(), env);
  assert.deepEqual(asked, ['esbuild-wasm']);
  assert.equal(res.pkg?.name, 'esbuild');
  assert.equal(res.pkg?.version, '0.20.1');
  assert.equal(res.messages.filter((m) => m.includes('[swap]')).length, 1, 'a transitive swap is announced exactly once');
  assert.deepEqual(res.events.filter((e) => e.type === 'swap'), [{ type: 'swap', from: 'esbuild', to: 'esbuild-wasm', ctx: 'transitive' }]);
  console.log('  transitive bare edge → same alias path, one transitive swap event');
}

// ── An explicit user alias to another package is authoritative ───────────
{
  const { env, asked } = registry(REGISTRY);
  const res = await resolveOnePackumentInFacet(spec({ range: 'npm:some-other@1.0.0' }), env);
  assert.deepEqual(asked, ['some-other'], 'the policy does not override the user\'s alias target');
  assert.equal(res.pkg?.name, 'esbuild');
  assert.equal(res.pkg?.version, '1.0.0');
  assert.ok(!res.events.some((e) => e.type === 'swap'));
  console.log('  explicit alias to another package → no swap');
}

// ── Policy applies to the registry identity, placement to the name ───────
//
// A user's explicit alias to the NATIVE package (`build-a@npm:esbuild`) is
// still esbuild at the registry, so the swap applies to its target — and
// the package keeps the name the alias declared. Two aliases of the same
// swapped identity install side by side under their own names.
{
  const { env, asked } = registry(REGISTRY);
  for (const name of ['build-a', 'build-b']) {
    const res = await resolveOnePackumentInFacet(spec({ name, range: 'npm:esbuild@^0.20.0' }), env);
    assert.equal(res.pkg?.name, name, 'the alias keeps its own install name');
    assert.equal(res.pkg?.version, '0.20.1');
    assert.match(res.pkg.tarballUrl, /esbuild-wasm-0\.20\.1\.tgz$/, 'the tarball is the swap target\'s');
    assert.deepEqual(res.events.filter((e) => e.type === 'swap'), [{ type: 'swap', from: 'esbuild', to: 'esbuild-wasm', ctx: 'transitive' }]);
  }
  assert.deepEqual(asked, ['esbuild-wasm', 'esbuild-wasm'], 'the native packument is never fetched');
  console.log('  explicit alias to the native package → its target is swapped, the alias name is kept');
}

// A reject advisory follows the same identity: an alias of a listed
// package is that package.
{
  const { env } = registry({ ...REGISTRY, sharp: packument('sharp', { '0.34.0': {} }) });
  const res = await resolveOnePackumentInFacet(spec({ name: 'img', range: 'npm:sharp@^0.34.0' }), env);
  assert.equal(res.pkg?.name, 'img');
  assert.equal(res.pkg?.version, '0.34.0');
  const advisories = res.events.filter((e) => e.type === 'advisory');
  assert.equal(advisories.length, 1, `one advisory (events=${JSON.stringify(res.events)})`);
  assert.equal(advisories[0].from, 'sharp', 'the advisory names the registry package');
  console.log('  explicit alias to a listed package → the advisory follows the registry identity');
}

// ── Warm cache: the entry the first install wrote answers the second ─────
{
  const { env, asked } = registry(REGISTRY);
  const first = await resolveOnePackumentInFacet(spec({ range: applySwaps({ esbuild: '^0.20.0' }).specs.esbuild }), env);
  const cachedEntries = first.cacheWrites;
  const second = await resolveOnePackumentInFacet(
    spec({ range: applySwaps({ esbuild: '^0.20.0' }).specs.esbuild, cachedEntries }),
    env,
  );
  assert.deepEqual(asked, ['esbuild-wasm'], 'the second resolve is a cache hit — no second packument fetch');
  assert.equal(second.packumentSource, 'cache-hit');
  assert.equal(second.pkg?.name, 'esbuild');
  assert.equal(second.pkg?.version, '0.20.1');
  assert.match(second.pkg.tarballUrl, /esbuild-wasm-0\.20\.1\.tgz$/);
  console.log('  warm cache → esbuild answered from the entry keyed by its install name');
}

console.log('npm-swap-alias-resolve: ok');
