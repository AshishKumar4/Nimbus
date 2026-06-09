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
} from '../../packages/worker/src/runtime/os-contracts.ts';
import {
  PACKAGE_ABI_POLICY,
  applySwaps,
  findRejects,
  lookupSwap,
  lookupReject,
  shouldWarnSkipTransitive,
  shouldSkipPackage,
  shouldSkipPackageWithFramework,
  nativeExecutableReject,
  isOptionalNativeBinding,
} from '../../packages/worker/src/facets/wasm-swap-registry.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../packages/worker/src/loaders/npm-resolve-preamble.ts';
import { registryEntryFromResolved } from '../../packages/worker/src/npm/resolver.ts';

// ── 1. Preamble parity: extract the injected policy + functions ────────

const facet = new Function(`${NPM_RESOLVE_PREAMBLE}
return {
  POLICY: __NIMBUS_PACKAGE_ABI_POLICY,
  SHOULD_SKIP_PACKAGE,
  SHOULD_SWAP,
  SHOULD_REJECT_FAIL,
  SHOULD_WARN_SKIP_TRANSITIVE,
  NATIVE_EXECUTABLE_REJECT,
  IS_OPTIONAL_NATIVE_BINDING,
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
  assert.deepEqual(
    facet.SHOULD_WARN_SKIP_TRANSITIVE(name),
    shouldWarnSkipTransitive(name),
    `warn-skip parity: ${name}`,
  );
  for (const frameworkAware of [false, true]) {
    assert.equal(
      facet.SHOULD_SKIP_PACKAGE(name, frameworkAware),
      shouldSkipPackageWithFramework(name, frameworkAware),
      `skip parity: ${name} (frameworkAware=${frameworkAware})`,
    );
  }
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

// applySwaps rewrites and is idempotent.
{
  const { specs, swaps } = applySwaps({ esbuild: '^0.20.0', react: '^18.0.0' });
  assert.deepEqual(specs, { 'esbuild-wasm': '^0.20.0', react: '^18.0.0' });
  assert.equal(swaps.length, 1);
  const again = applySwaps(specs);
  assert.deepEqual(again.specs, specs);
  assert.equal(again.swaps.length, 0);
}

// findRejects depth semantics: 'warn' entries fire only at top level.
{
  const specs = { fsevents: '*', sharp: '*', react: '*' };
  assert.deepEqual(findRejects(specs, 'top').map((r) => r.from).sort(), ['fsevents', 'sharp']);
  assert.deepEqual(findRejects(specs, 'transitive').map((r) => r.from), ['sharp']);
}

// Framework-aware skip exemption.
assert.equal(shouldSkipPackage('vite'), true);
assert.equal(shouldSkipPackageWithFramework('vite', true), false);
assert.equal(shouldSkipPackage('@types/node'), true);
assert.equal(shouldSkipPackage('react'), false);

// ── 3. Metadata-driven native-artifact rejection ────────────────────────

// Native executable bin (the opencode-ai shape). The reason text is a
// live behavioral contract: tests/behavioral/agentic-cli/new/
// opencode-native-bin-diagnostic.mjs asserts these substrings against
// production output. Update that probe in lockstep with any change.
{
  const reject = nativeExecutableReject({
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
assert.ok(nativeExecutableReject({ name: 'addon', bin: { a: 'dist/a.node' } }));
assert.ok(nativeExecutableReject({ name: 'addon', bin: { a: 'dist/a.node?module#x' } }));

// package.json os/cpu/libc allowlists classify as platform-native.
{
  const reject = nativeExecutableReject({
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
assert.ok(nativeExecutableReject({ name: 'glibc-only', libc: ['glibc'] }));

// Pure negations exclude platforms without requiring one — not native.
assert.equal(
  nativeExecutableReject({ name: 'not-windows', bin: { cli: 'dist/cli.js' }, os: ['!win32'] }),
  undefined,
);

// Plain JavaScript packages never reject.
assert.equal(nativeExecutableReject({ name: 'pure', bin: { cli: 'dist/cli.js' } }), undefined);
assert.equal(nativeExecutableReject({ name: 'no-bin' }), undefined);

// Preamble-side classifier matches on the same fixtures.
for (const fixture of [
  { name: 'opencode-ai', bin: { opencode: 'bin/opencode.exe' } },
  { name: 'opencode-linux-x64', os: ['linux'], cpu: ['x64'] },
  { name: 'not-windows', os: ['!win32'] },
  { name: 'pure', bin: { cli: 'dist/cli.js' } },
]) {
  assert.deepEqual(
    facet.NATIVE_EXECUTABLE_REJECT(fixture),
    nativeExecutableReject(fixture),
    `native-reject parity: ${fixture.name}`,
  );
}

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

// ── 4. Registry-cache entries persist ABI-relevant metadata ────────────

{
  const entry = registryEntryFromResolved({
    name: 'opencode-linux-x64',
    version: '1.16.2',
    tarballUrl: 'https://registry.npmjs.org/opencode-linux-x64/-/opencode-linux-x64-1.16.2.tgz',
    integrity: 'sha512-abc',
    dependencies: {},
    optionalDependencies: { fsevents: '^2.0.0' },
    os: ['linux'],
    cpu: ['x64'],
    exports: null,
    main: '',
    module: '',
    bin: {},
  });
  assert.deepEqual(JSON.parse(entry.platformJson), { os: ['linux'], cpu: ['x64'] });
  assert.deepEqual(JSON.parse(entry.optionalDepsJson), { fsevents: '^2.0.0' });
}
{
  const entry = registryEntryFromResolved({
    name: 'left-pad',
    version: '1.3.0',
    tarballUrl: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
    integrity: 'sha512-def',
    dependencies: {},
    exports: null,
    main: 'index.js',
    module: '',
    bin: {},
  });
  assert.deepEqual(JSON.parse(entry.platformJson), {});
  assert.deepEqual(JSON.parse(entry.optionalDepsJson), {});
}

console.log('package-abi-policy: ok');
