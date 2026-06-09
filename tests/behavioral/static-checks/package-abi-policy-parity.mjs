#!/usr/bin/env bun
// static-checks/package-abi-policy-parity — the supervisor's package ABI
// policy and the policy injected into resolver facet preambles must stay
// equivalent. The preamble is GENERATED from PACKAGE_ABI_POLICY, so this
// check compiles the injected preamble, extracts the policy + policy
// functions, and asserts full parity: the policy object itself plus the
// behavior of every decision function across the whole policy surface.

import { makeAsserter } from '../_driver.mjs';
import {
  PACKAGE_ABI_POLICY,
  lookupSwap,
  lookupReject,
  shouldWarnSkipTransitive,
  shouldSkipPackageWithFramework,
  nativeExecutableReject,
  isOptionalNativeBinding,
} from '../../../packages/worker/src/facets/wasm-swap-registry.ts';
import { NPM_RESOLVE_PREAMBLE } from '../../../packages/worker/src/loaders/npm-resolve-preamble.ts';

const a = makeAsserter('static-checks/package-abi-policy-parity');

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

// 1. The injected policy object IS the supervisor policy object.
a.check(
  'injected policy equals supervisor policy',
  JSON.stringify(facet.POLICY) === JSON.stringify(PACKAGE_ABI_POLICY),
  'policy objects diverged',
);

// 2. Functional parity across every name the policy mentions, plus
//    representative non-policy names.
const names = [
  ...PACKAGE_ABI_POLICY.swaps.map((s) => s.from),
  ...PACKAGE_ABI_POLICY.swaps.map((s) => s.to),
  ...PACKAGE_ABI_POLICY.rejects.map((r) => r.from),
  ...PACKAGE_ABI_POLICY.skipPackages,
  ...PACKAGE_ABI_POLICY.skipPrefixes.map((p) => `${p}example`),
  ...PACKAGE_ABI_POLICY.frameworkRequiredPackages,
  ...PACKAGE_ABI_POLICY.nativeShardPrefixes.map((p) => `${p}linux-x64`),
  ...PACKAGE_ABI_POLICY.nativeShardExemptions,
  'react', 'left-pad', '@scope/pkg',
];

const same = (label, x, y) => a.check(
  label,
  JSON.stringify(x ?? null) === JSON.stringify(y ?? null),
  `supervisor=${JSON.stringify(x ?? null)} facet=${JSON.stringify(y ?? null)}`,
);

for (const name of names) {
  same(`swap('${name}')`, lookupSwap(name), facet.SHOULD_SWAP(name));
  const reject = lookupReject(name);
  same(
    `reject-fail('${name}')`,
    reject && reject.transitive === 'fail' ? reject : undefined,
    facet.SHOULD_REJECT_FAIL(name),
  );
  same(`warn-skip('${name}')`, shouldWarnSkipTransitive(name), facet.SHOULD_WARN_SKIP_TRANSITIVE(name));
  for (const frameworkAware of [false, true]) {
    same(
      `skip('${name}', frameworkAware=${frameworkAware})`,
      shouldSkipPackageWithFramework(name, frameworkAware),
      facet.SHOULD_SKIP_PACKAGE(name, frameworkAware),
    );
  }
}

// 3. Native-artifact classification parity across the metadata surface:
//    bin extensions, platform constraints, and shard-name heuristics.
const fixtures = [
  { name: 'windows-bin', bin: { tool: 'bin/tool.exe' } },
  { name: 'native-addon-bin', bin: { addon: 'dist/addon.node' } },
  { name: 'native-addon-with-query', bin: { addon: 'dist/addon.node?module#hash' } },
  { name: 'javascript-bin', bin: { cli: 'dist/cli.js' } },
  { name: 'extensionless-bin', bin: { cli: 'dist/cli' } },
  { name: 'empty-bin', bin: {} },
  { name: 'linux-only', bin: { cli: 'dist/cli.js' }, os: ['linux'] },
  { name: 'x64-only', bin: {}, cpu: ['x64'] },
  { name: 'glibc-only', libc: ['glibc'] },
  { name: 'not-windows', bin: { cli: 'dist/cli.js' }, os: ['!win32'] },
  { name: 'node-main', main: 'build/binding.node' },
  { name: '@rollup/rollup-linux-x64-gnu', os: ['linux'], cpu: ['x64'] },
  { name: '@rollup/wasm-node' },
  { name: '@parcel/watcher' },
];

for (const fixture of fixtures) {
  same(
    `native-reject(${fixture.name})`,
    nativeExecutableReject(fixture),
    facet.NATIVE_EXECUTABLE_REJECT(fixture),
  );
  same(
    `optional-native-binding(${fixture.name})`,
    isOptionalNativeBinding(fixture),
    facet.IS_OPTIONAL_NATIVE_BINDING(fixture),
  );
}

const sum = a.summary();
process.exit(sum.fail > 0 ? 1 : 0);
