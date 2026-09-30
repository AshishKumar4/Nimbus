#!/usr/bin/env bun
// package-abi-policy — the supervisor's PACKAGE_ABI_POLICY is the one
// source of truth for npm swap/reject/skip/native-artifact decisions.
// This test:
//   1. compiles the generated facet preamble, extracts the injected
//      policy, and asserts equality with the supervisor policy
//      (mechanical anti-drift gate);
//   2. asserts the metadata-driven native-artifact classification
//      behavior, including the diagnostic contract the live
//      opencode-native-bin-diagnostic probe depends on;
//   3. asserts the policy round-trips platform/optional-dep metadata
//      through registry cache entries.

import assert from 'node:assert/strict';
import {
  NIMBUS_ABI_TARGET,
  PYODIDE_PACKAGE_ABI,
  NATIVE_UNSUPPORTED_ABI,
} from '../../packages/core/src/runtime/os-contracts.ts';
import {
  PACKAGE_ABI_POLICY,
  applySwaps,
  findRejects,
  lookupSwap,
  lookupReject,
  isOptionalNativeBinding,
  lookupStagedArtifact,
  applyStagedArtifact,
} from '../../packages/worker/src/facets/wasm-swap-registry.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../packages/worker/src/loaders/npm-resolve-preamble.ts';
import { parseRegistryRequest } from '../../packages/worker/src/npm/resolve-one-facet.ts';

// ── 1. Preamble parity: extract the injected policy + functions ────────

const facet = new Function(`${NPM_RESOLVE_PREAMBLE}
return {
  POLICY: __NIMBUS_PACKAGE_ABI_POLICY,
  SHOULD_SWAP,
  SHOULD_REJECT_FAIL,
  NATIVE_EXECUTABLE_REJECT,
  NATIVE_PLATFORM_REJECT,

  IS_OPTIONAL_NATIVE_BINDING,
  STAGED_ARTIFACT,
  STAGED_ARTIFACT_APPLY,
};`)();

assert.deepEqual(
  JSON.parse(JSON.stringify(facet.POLICY)),
  JSON.parse(JSON.stringify(PACKAGE_ABI_POLICY)),
  'injected facet policy must equal the supervisor policy',
);

// Full functional parity over every policy-mentioned name plus controls.
const names = [
  ...PACKAGE_ABI_POLICY.swaps.flatMap((s) => [s.from, s.to]),
  ...PACKAGE_ABI_POLICY.rejects.map((r) => r.from),
  ...PACKAGE_ABI_POLICY.skipPackages,
  ...PACKAGE_ABI_POLICY.skipPrefixes.map((p) => `${p}example`),
  ...PACKAGE_ABI_POLICY.frameworkRequiredPackages,
  ...PACKAGE_ABI_POLICY.nativeShardPrefixes.map((p) => `${p}linux-x64`),
  ...PACKAGE_ABI_POLICY.nativeShardExemptions,
  'react', 'left-pad', '@scope/pkg',
];
for (const name of names) {
  assert.deepEqual(facet.SHOULD_SWAP(name), lookupSwap(name), `swap parity: ${name}`);
  const reject = lookupReject(name);
  assert.deepEqual(
    facet.SHOULD_REJECT_FAIL(name),
    reject && reject.transitive === 'fail' ? reject : undefined,
    `reject-fail parity: ${name}`,
  );

}

// ── 2. Policy model invariants ──────────────────────────────────────────

assert.equal(PACKAGE_ABI_POLICY.abiTarget, NIMBUS_ABI_TARGET);
assert.equal(PACKAGE_ABI_POLICY.nativeArtifactClass, NATIVE_UNSUPPORTED_ABI);
for (const cls of ['javascript', NIMBUS_ABI_TARGET, PYODIDE_PACKAGE_ABI, 'ruby-wasm']) {
  assert.ok(
    PACKAGE_ABI_POLICY.acceptedArtifactClasses.includes(cls),
    `accepted artifact classes must include ${cls}`,
  );
}
assert.ok(
  !PACKAGE_ABI_POLICY.acceptedArtifactClasses.includes(NATIVE_UNSUPPORTED_ABI),
  'native-unsupported is never an accepted artifact class',
);

// Swap and reject names are disjoint; swaps are drop-in only.
for (const swap of PACKAGE_ABI_POLICY.swaps) {
  assert.equal(swap.compat, 'drop-in');
  assert.equal(lookupReject(swap.from), undefined, `${swap.from} owns one role`);
}

// applySwaps rewrites a swap into an alias RANGE under the declared KEY —
// `esbuild@npm:esbuild-wasm@^0.20.0` — and is idempotent. The key is what
// names the install directory, so renaming it is what left
// `require('esbuild')` unresolvable after `npm install esbuild`.
{
  const { specs, swaps } = applySwaps({ esbuild: '^0.20.0', react: '^18.0.0' });
  assert.deepEqual(specs, { esbuild: 'npm:esbuild-wasm@^0.20.0', react: '^18.0.0' });
  assert.equal(swaps.length, 1);
  const again = applySwaps(specs);
  assert.deepEqual(again.specs, specs);
  assert.equal(again.swaps.length, 0);
}

// Every ungated swap entry takes the alias form; a swap with `since` is left
// to the resolver, which reads the target's versions (npm-swap-alias-resolve).
// Every key the caller declared survives. A sibling spec naming the swap
// TARGET directly is a distinct key and must not be overwritten by the swap
// (the old key rename did).
{
  const declared = {};
  for (const swap of PACKAGE_ABI_POLICY.swaps) declared[swap.from] = '^1.0.0';
  for (const swap of PACKAGE_ABI_POLICY.swaps) declared[swap.to] = '^2.0.0';
  const { specs, swaps } = applySwaps(declared);
  const ungated = PACKAGE_ABI_POLICY.swaps.filter((swap) => !swap.since);
  assert.equal(swaps.length, ungated.length);
  assert.deepEqual(Object.keys(specs).sort(), Object.keys(declared).sort(), 'no declared key is lost');
  for (const swap of PACKAGE_ABI_POLICY.swaps) {
    assert.equal(specs[swap.from], swap.since ? '^1.0.0' : `npm:${swap.to}@^1.0.0`, `${swap.from} aliases its target unless gated`);
    assert.equal(specs[swap.to], '^2.0.0', `${swap.to} keeps its own spec`);
  }
}

// An explicit alias the user typed is authoritative; a bare name with no
// range aliases `latest`.
{
  const { specs, swaps } = applySwaps({ esbuild: 'npm:some-other@0.19.0', 'esbuild-wasm': '' });
  assert.deepEqual(specs, { esbuild: 'npm:some-other@0.19.0', 'esbuild-wasm': '' });
  assert.deepEqual(swaps, []);
  const bare = applySwaps({ esbuild: '' });
  assert.deepEqual(bare.specs, { esbuild: 'npm:esbuild-wasm@latest' });
  assert.deepEqual(bare.swaps.map((s) => s.from), ['esbuild']);
}

// The alias range applySwaps writes is the one the resolver facet's own
// parser reads back: the target as registry name, the user's range as the
// range, the declared key as the install name.
{
  const { specs } = applySwaps({ esbuild: '^0.20.0' });
  assert.deepEqual(parseRegistryRequest('esbuild', specs.esbuild), {
    installName: 'esbuild', registryName: 'esbuild-wasm', range: '^0.20.0', alias: true,
  });
}

// Staged artifacts are not swaps: they keep their own name and range.
for (const staged of PACKAGE_ABI_POLICY.stagedArtifacts) {
  const { specs, swaps } = applySwaps({ [staged.from]: '^1.0.0' });
  assert.deepEqual(specs, { [staged.from]: '^1.0.0' }, `${staged.from} is not rewritten`);
  assert.equal(swaps.length, 0);
}

// findRejects: every table entry is 'fail' now, so 'top' and
// 'transitive' are the same set.
{
  const specs = { fsevents: '*', sharp: '*', react: '*' };
  assert.deepEqual(findRejects(specs, 'top').map((r) => r.from), ['sharp']);
  assert.deepEqual(findRejects(specs, 'transitive').map((r) => r.from), ['sharp']);
}

// The skip fields exist only because PackageAbiPolicy is a public
// @nimbus-sh/core type; they are empty and read by nothing — a declared
// dependency is installed or refused loudly, never silently left out.
assert.deepEqual(PACKAGE_ABI_POLICY.skipPackages, []);
assert.deepEqual(PACKAGE_ABI_POLICY.skipPrefixes, []);
assert.deepEqual(PACKAGE_ABI_POLICY.frameworkRequiredPackages, []);
// Retired 'warn' toolchain entries install like any other package.
for (const name of ['fsevents', 'bufferutil', 'utf-8-validate', 'wrangler', '@cloudflare/vite-plugin', 'parcel', 'node-gyp', 'node-pre-gyp']) {
  assert.equal(lookupReject(name), undefined, `${name} has no reject entry`);
}

// ── 3. Metadata-driven native-artifact rejection ────────────────────────

// Native executable bin (the opencode-ai shape). The reason text is a
// live behavioral contract: tests/behavioral/agentic-cli/new/
// opencode-native-bin-diagnostic.mjs asserts these substrings against
// production output. Update that probe in lockstep with any change.
{
  const reject = facet.NATIVE_EXECUTABLE_REJECT({
    name: 'opencode-ai',
    bin: { opencode: 'bin/opencode.exe' },
  });
  assert.ok(reject, 'native .exe bin must reject');
  assert.equal(reject.from, 'opencode-ai');
  assert.equal(reject.transitive, 'fail');
  assert.match(reject.reason, /native executable bin/);
  assert.match(reject.reason, /'bin\/opencode\.exe'/);
  assert.match(reject.reason, new RegExp(`artifact class '${NATIVE_UNSUPPORTED_ABI}'`));
  assert.match(reject.reason, /cannot execute Linux\/Windows\/macOS native binaries/);
  assert.match(reject.reason, /JavaScript, WASM, or wasm32-wasi-nimbus artifact/);
}

// .node bins reject; query/fragment suffixes don't hide the extension.
assert.ok(facet.NATIVE_EXECUTABLE_REJECT({ name: 'addon', bin: { a: 'dist/a.node' } }));
assert.ok(facet.NATIVE_EXECUTABLE_REJECT({ name: 'addon', bin: { a: 'dist/a.node?module#x' } }));

// package.json os/cpu/libc allowlists classify as platform-native.
{
  const reject = facet.NATIVE_EXECUTABLE_REJECT({
    name: 'opencode-linux-x64',
    bin: {},
    os: ['linux'],
    cpu: ['x64'],
  });
  assert.ok(reject, 'positive platform allowlist must reject');
  assert.match(reject.reason, /opencode-linux-x64/);
  assert.match(reject.reason, /os=\[linux\]/);
  assert.match(reject.reason, /cpu=\[x64\]/);
  assert.match(reject.reason, new RegExp(`artifact class '${NATIVE_UNSUPPORTED_ABI}'`));
  assert.match(reject.reason, /JavaScript, WASM, or wasm32-wasi-nimbus artifact/);
}
assert.ok(facet.NATIVE_EXECUTABLE_REJECT({ name: 'glibc-only', libc: ['glibc'] }));

// Pure negations exclude platforms without requiring one — not native.
assert.equal(
  facet.NATIVE_EXECUTABLE_REJECT({ name: 'not-windows', bin: { cli: 'dist/cli.js' }, os: ['!win32'] }),
  undefined,
);

// Plain JavaScript packages never reject.
assert.equal(facet.NATIVE_EXECUTABLE_REJECT({ name: 'pure', bin: { cli: 'dist/cli.js' } }), undefined);
assert.equal(facet.NATIVE_EXECUTABLE_REJECT({ name: 'no-bin' }), undefined);


// Optional-dependency native-binding heuristic (silent-skip path).
assert.equal(isOptionalNativeBinding({ name: '@rollup/rollup-linux-x64-gnu', os: ['linux'] }), true);
assert.equal(isOptionalNativeBinding({ name: '@esbuild/linux-x64' }), true);
assert.equal(isOptionalNativeBinding({ name: 'binding', main: 'build/binding.node' }), true);
assert.equal(isOptionalNativeBinding({ name: '@parcel/watcher' }), false, 'parent wrapper is not a shard');
assert.equal(isOptionalNativeBinding({ name: '@rollup/wasm-node' }), false, 'pure-WASM build is exempt');
assert.equal(isOptionalNativeBinding({ name: 'left-pad' }), false);
for (const fixture of [
  { name: '@rollup/rollup-linux-x64-gnu', os: ['linux'] },
  { name: '@rollup/wasm-node' },
  { name: 'binding', main: 'build/binding.node' },
  { name: 'left-pad' },
]) {
  assert.equal(
    facet.IS_OPTIONAL_NATIVE_BINDING(fixture),
    isOptionalNativeBinding(fixture),
    `optional-binding parity: ${fixture.name}`,
  );
}

// ── 3b. Staged-artifact lookup + rewrite parity ─────────────────────────
// The facet rewrites native packages with a staged Nimbus build — a native
// launcher (opencode-ai, `bin`) or a native N-API binding (rolldown,
// `binding`) — via the injected __policyApplyStagedArtifact. Assert the
// facet's lookup and rewrite produce the identical pkg as the supervisor's
// applyStagedArtifact, so the two paths can never drift.
for (const entry of PACKAGE_ABI_POLICY.stagedArtifacts) {
  assert.deepEqual(
    facet.STAGED_ARTIFACT(entry.from),
    lookupStagedArtifact(entry.from),
    `staged-artifact lookup parity: ${entry.from}`,
  );

  // Realistic native shape: a bin + platform-native shards + os/cpu/libc
  // allowlists — what the rewrite must clear (and, for a launcher, redirect).
  const makePkg = () => ({
    name: entry.from,
    bin: { [entry.kind === 'bin' ? entry.bin : entry.from]: 'bin/cli.js' },
    optionalDependencies: { [`${entry.from}-linux-x64`]: '1.0.0', [`${entry.from}-darwin-arm64`]: '1.0.0' },
    os: ['darwin', 'linux', 'win32'],
    cpu: ['arm64', 'x64'],
    libc: ['glibc'],
  });

  const supervisorPkg = makePkg();
  const staged = lookupStagedArtifact(entry.from);
  assert.ok(staged, `supervisor must resolve staged entry for ${entry.from}`);
  applyStagedArtifact(supervisorPkg, staged);

  const facetPkg = makePkg();
  facet.STAGED_ARTIFACT_APPLY(facetPkg, facet.STAGED_ARTIFACT(entry.from));

  assert.deepEqual(
    facetPkg,
    supervisorPkg,
    `staged-artifact rewrite parity: ${entry.from}`,
  );
  // A launcher's bin becomes the staged sentinel; a binding's JavaScript
  // (and its bin) run as published. Both lose their native shards.
  if (entry.kind === 'bin') assert.equal(facetPkg.bin[entry.bin], `nimbus-staged:${entry.artifact}`);
  else assert.deepEqual(facetPkg.bin, { [entry.from]: 'bin/cli.js' });
  assert.equal(facetPkg.optionalDependencies, undefined);
  assert.equal(facetPkg.os, undefined);
  assert.equal(facetPkg.cpu, undefined);
  assert.equal(facetPkg.libc, undefined);
}
// Each staged napi binding answers its owner package and every package name
// the owner requires it by (Astro 7 needs satteri and its compiler; Vite 8
// and Nuxt need rolldown), at the version the binding is built from; none of
// them is refused.
for (const [owner, wasi, artifact] of [
  ['rolldown', '@rolldown/binding-wasm32-wasi', 'rolldown'],
  ['satteri', '@bruits/satteri-wasm32-wasi', 'satteri'],
  ['@astrojs/compiler-binding', '@astrojs/compiler-binding-wasm32-wasi', 'astro-compiler'],
]) {
  for (const name of [owner, wasi]) {
    const staged = lookupStagedArtifact(name);
    assert.equal(staged?.kind, 'binding', `${name} is a staged binding`);
    assert.equal(staged?.artifact, artifact, `${name} is answered by the ${artifact} build`);
    assert.match(staged?.version ?? '', /^\d+\.\d+\.\d+$/, `${name} names the version it is built from`);
    assert.equal(lookupReject(name), undefined, `${name} has no reject entry`);
  }
}
// Names with no staged entry are left untouched by both paths.
assert.equal(facet.STAGED_ARTIFACT('left-pad'), undefined);
assert.deepEqual(facet.STAGED_ARTIFACT('left-pad'), lookupStagedArtifact('left-pad'));

console.log('package-abi-policy: ok');
