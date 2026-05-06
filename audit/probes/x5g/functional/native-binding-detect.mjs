#!/usr/bin/env bun
// X5G functional G1: isOptionalNativeBinding(packument) detects native
// platform shards correctly.
//
// Positive cases: explicit os/cpu/libc, .node main, glob name match.
// Negative cases: pure-JS package with no platform constraints.

import { ok, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/wasm-swap-registry.ts');

group('helper exists', () => {
  ok('exports isOptionalNativeBinding', typeof reg.isOptionalNativeBinding === 'function');
});

if (typeof reg.isOptionalNativeBinding !== 'function') {
  // Cannot continue without the helper. Mark a clear FAIL and exit.
  console.log('# X5G G1 helper not implemented yet — TDD red phase');
  summary('native-binding-detect (RED)');
}

const fn = reg.isOptionalNativeBinding;

group('positive: os/cpu/libc constraints', () => {
  ok('os: ["linux"] → true', fn({ os: ['linux'] }) === true);
  ok('cpu: ["x64"] → true', fn({ cpu: ['x64'] }) === true);
  ok('libc: ["glibc"] → true', fn({ libc: ['glibc'] }) === true);
  ok('os: ["linux"], cpu: ["x64"], libc: ["glibc"] → true', fn({ os: ['linux'], cpu: ['x64'], libc: ['glibc'] }) === true);
});

group('positive: .node main', () => {
  ok('main "./rollup.linux-x64-gnu.node" → true', fn({ main: './rollup.linux-x64-gnu.node' }) === true);
  ok('main "rollup.node" → true', fn({ main: 'rollup.node' }) === true);
});

group('positive: known native-shard name globs', () => {
  ok('@rollup/rollup-linux-x64-gnu → true', fn({ name: '@rollup/rollup-linux-x64-gnu' }) === true);
  ok('@rollup/rollup-darwin-arm64 → true', fn({ name: '@rollup/rollup-darwin-arm64' }) === true);
  ok('@parcel/watcher-linux-x64-glibc → true', fn({ name: '@parcel/watcher-linux-x64-glibc' }) === true);
  ok('@swc/core-linux-x64-gnu → true', fn({ name: '@swc/core-linux-x64-gnu' }) === true);
  ok('@next/swc-linux-x64-gnu → true', fn({ name: '@next/swc-linux-x64-gnu' }) === true);
  ok('@tailwindcss/oxide-linux-x64-gnu → true', fn({ name: '@tailwindcss/oxide-linux-x64-gnu' }) === true);
  ok('@img/sharp-linux-x64 → true', fn({ name: '@img/sharp-linux-x64' }) === true);
  ok('@napi-rs/canvas-linux-x64-gnu → true', fn({ name: '@napi-rs/canvas-linux-x64-gnu' }) === true);
});

group('negative: pure-JS packages', () => {
  ok('react → false', fn({ name: 'react' }) === false);
  ok('lodash → false', fn({ name: 'lodash' }) === false);
  ok('pure-JS with main ./index.js → false', fn({ main: './index.js' }) === false);
  ok('empty packument → false', fn({}) === false);
  ok('no platform fields, name not glob → false', fn({ name: 'rollup' }) === false);
});

group('edge cases', () => {
  ok('os: [] (empty) → false', fn({ os: [] }) === false);
  ok('parent shard (e.g. @rollup/wasm-node) → false', fn({ name: '@rollup/wasm-node' }) === false);
  ok('@parcel/watcher (parent, not platform shard) → false', fn({ name: '@parcel/watcher' }) === false);
});

summary('native-binding-detect');
