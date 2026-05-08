#!/usr/bin/env bun
// W6.5 regression: extends W6's symmetric-paths probe with new W6.5 entries.
//
// Adds new REJECT entries (sharp-wasm32, @napi-rs/canvas, @napi-rs/canvas-wasm32-wasi)
// and a transitive-swap row (esbuild appearing as a transitive dep) to the test set.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ok, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREAMBLE_PATH = path.resolve(HERE, '../../../../src/parallel/npm-resolve-preamble.ts');

const reg = await import('../../../../src/facets/wasm-swap-registry.ts');
const preambleSrc = readFileSync(PREAMBLE_PATH, 'utf8');

const NEW_W6_5_ENTRIES = [
  '@img/sharp-wasm32',
  '@napi-rs/canvas',
  '@napi-rs/canvas-wasm32-wasi',
];

group('w6.5 new REJECT entries are reachable from registry', () => {
  for (const n of NEW_W6_5_ENTRIES) {
    const e = reg.lookupReject(n);
    ok(`'${n}' has reject entry`, !!e);
  }
});

group('w6.5 new REJECT entries are mirrored in preamble', () => {
  for (const n of NEW_W6_5_ENTRIES) {
    const re = new RegExp(`['"]${n.replace(/[@/]/g, '\\$&')}['"]`);
    ok(`preamble has '${n}'`, re.test(preambleSrc));
  }
});

group('transitive-swap row: esbuild swap is symmetric across paths', () => {
  // Both supervisor's WASM_SWAPS and preamble's __WASM_SWAPS must contain esbuild.
  const supSwap = reg.lookupSwap('esbuild');
  ok('supervisor: esbuild → esbuild-wasm', supSwap?.to === 'esbuild-wasm');
  ok('preamble: contains esbuild', /['"]esbuild['"]/.test(preambleSrc));
  ok('preamble: contains esbuild-wasm', /['"]esbuild-wasm['"]/.test(preambleSrc));
});

summary('resolver-paths-symmetric-w6.5');
