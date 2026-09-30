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
  'NATIVE_EXECUTABLE_REJECT', 'NATIVE_PLATFORM_REJECT', 'IS_OPTIONAL_NATIVE_BINDING',
  'PARSE_SEMVER', 'COMPARE_SEMVER', 'SATISFIES_RANGE', 'RESOLVE_VERSION', 'IS_SEMVER_RANGE',
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

// ── rollup: only rollup 4 has native shards ──────────────────────────────
// @rollup/wasm-node publishes 4.x only. Vite 3/4's rollup@^3 must install as
// the plain-JS rollup 3 it asked for, not be moved to the target's latest 4.x.
{
  const ROLLUP = {
    rollup: packument('rollup', { '3.29.4': {}, '3.29.5': {}, '4.63.5': { optionalDependencies: { '@rollup/rollup-linux-x64-gnu': '4.63.5' } } }),
    '@rollup/wasm-node': packument('@rollup/wasm-node', { '4.0.0': {}, '4.63.5': {} }),
  };
  assert.deepEqual(applySwaps({ rollup: '^3.29.4' }).specs, { rollup: '^3.29.4' },
    'the supervisor leaves a since-gated range for the resolver');
  for (const topLevel of [true, false]) {
    // A registry that serves rollup but not @rollup/wasm-node (a private
    // mirror): rollup 3 never needs the target, so it installs.
    const mirror = registry({ rollup: ROLLUP.rollup });
    const three = await resolveOnePackumentInFacet(spec({ name: 'rollup', range: '^3.27.1', topLevel }), mirror.env);
    assert.deepEqual(mirror.asked, ['rollup'], 'rollup 3 is resolved from rollup alone');
    assert.equal(three.pkg?.version, '3.29.5', 'rollup@^3 resolves to rollup 3');
    assert.match(three.pkg.tarballUrl, /\/rollup-3\.29\.5\.tgz$/, 'from rollup itself');
    assert.ok(!three.events.some((e) => e.type === 'swap'), 'and is not announced as a swap');
    const four = await resolveOnePackumentInFacet(spec({ name: 'rollup', range: '^4.0.0', topLevel }), registry(ROLLUP).env);
    assert.equal(four.pkg?.name, 'rollup');
    assert.equal(four.pkg?.version, '4.63.5');
    assert.match(four.pkg.tarballUrl, /wasm-node-4\.63\.5\.tgz$/, 'rollup 4 installs as @rollup/wasm-node');
    assert.equal(four.events.filter((e) => e.type === 'swap').length, 1);
    const latest = await resolveOnePackumentInFacet(spec({ name: 'rollup', range: 'latest', topLevel }), registry(ROLLUP).env);
    assert.match(latest.pkg.tarballUrl, /wasm-node-4\.63\.5\.tgz$/, 'latest is rollup 4, swapped');
  }
  console.log('  rollup@^3 installs as published; rollup 4 swaps to @rollup/wasm-node');
  // A mirror whose @rollup/wasm-node lags rollup: the target stands in only
  // with the very version rollup resolved to. Without it rollup installs
  // unswapped, with the note, never as wasm-node's own latest (4.0.0).
  const lagging = registry({ rollup: ROLLUP.rollup, '@rollup/wasm-node': packument('@rollup/wasm-node', { '4.0.0': {} }) });
  const behind = await resolveOnePackumentInFacet(spec({ name: 'rollup', range: '^4.50.0' }), lagging.env);
  assert.equal(behind.pkg?.version, '4.63.5', 'the version the range asked for');
  assert.match(behind.pkg.tarballUrl, /\/rollup-4\.63\.5\.tgz$/, 'from rollup itself, unswapped');
  assert.ok(!behind.events.some((e) => e.type === 'swap'), 'not announced as a swap');
  assert.ok(behind.events.some((e) => e.type === 'advisory' && e.from === 'rollup' && /publishes no 4\.63\.5/.test(e.reason)),
    `and the note says why it cannot run here: ${JSON.stringify(behind.events)}`);
  console.log('  a lagging swap target never answers with a version outside the range');
}

// A package whose binding Nimbus stages installs at the staged version when
// the range admits it, however new the registry's latest: Vite 8's
// rolldown ~1.2.9 stays on the staged build the day upstream publishes the
// next patch. A range or lock that excludes it keeps its own version, with
// the note that its binding will not load; a cache without the staged
// version is not taken for it.
{
  const staged = globalThis.STAGED_ARTIFACT('rolldown');
  assert.equal(staged?.kind, 'binding', 'rolldown\'s binding is staged');
  const [major, minor, patch] = staged.version.split('.').map(Number);
  const newer = `${major}.${minor}.${patch + 1}`;
  const ROLLDOWN = { rolldown: packument('rolldown', { [`${major}.${minor}.0`]: {}, [staged.version]: {}, [newer]: {} }) };
  const within = await resolveOnePackumentInFacet(spec({ name: 'rolldown', range: `~${major}.${minor}.0` }), registry(ROLLDOWN).env);
  assert.equal(within.pkg?.version, staged.version, `~${major}.${minor}.0 installs the staged ${staged.version}, not ${newer}`);
  const open = await resolveOnePackumentInFacet(spec({ name: 'rolldown', range: 'latest' }), registry(ROLLDOWN).env);
  assert.equal(open.pkg?.version, staged.version, 'an open request installs the staged version');
  const pinned = await resolveOnePackumentInFacet(spec({ name: 'rolldown', range: newer }), registry(ROLLDOWN).env);
  assert.equal(pinned.pkg?.version, newer, 'an exact pin (a lockfile) is honoured');
  assert.ok(pinned.events.some((e) => e.type === 'advisory' && e.from === 'rolldown'), 'with the note that it will not load');
  const cachedNewer = { name: 'rolldown', version: newer, tarballUrl: `https://registry.invalid/rolldown/-/rolldown-${newer}.tgz`, integrity: 'sha512-x', depsJson: '{}', exportsJson: 'null', main: '', moduleField: '', binJson: '{}', fetchedAt: 0 };
  const fromCache = registry(ROLLDOWN);
  const skipped = await resolveOnePackumentInFacet(spec({ name: 'rolldown', range: `^${major}.${minor}.0`, cachedEntries: [cachedNewer] }), fromCache.env);
  assert.deepEqual(fromCache.asked, ['rolldown'], 'a cache holding only a newer rolldown is not taken for the staged one');
  assert.equal(skipped.pkg?.version, staged.version);
  console.log(`  rolldown installs at its staged ${staged.version} whenever the range admits it`);
}

// A semver range nothing satisfies is unresolved (npm's ETARGET), for a swap
// target as for any package: it never falls back to the target's latest.
{
  const { specs } = applySwaps({ esbuild: '^0.30.0' });
  const res = await resolveOnePackumentInFacet(spec({ range: specs.esbuild, topLevel: true }), registry(REGISTRY).env);
  assert.equal(res.pkg, null, `no esbuild-wasm 0.30.x: nothing is installed, not 0.20.1 (${res.pkg?.version})`);
  assert.equal(res.error?.type, 'unresolved');
  const tag = await resolveOnePackumentInFacet(spec({ range: 'npm:esbuild-wasm@latest', topLevel: true }), registry(REGISTRY).env);
  assert.equal(tag.pkg?.version, '0.20.1', 'a tag still resolves to its dist-tag');
  console.log('  an unsatisfiable range is unresolved, never latest');
}

console.log('npm-swap-alias-resolve: ok');
