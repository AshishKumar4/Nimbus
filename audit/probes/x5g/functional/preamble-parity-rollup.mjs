#!/usr/bin/env bun
// X5G functional: the preamble's __WASM_SWAPS map mirrors the new
// rollup → @rollup/wasm-node entry. Extends the W6.5 preamble-parity
// gate.

import { ok, group, summary } from '../../w6/_tap.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREAMBLE = path.join(HERE, '../../../../src/parallel/npm-resolve-preamble.ts');
const REGISTRY = path.join(HERE, '../../../../src/facets/wasm-swap-registry.ts');

const preamble = fs.readFileSync(PREAMBLE, 'utf8');
const registry = fs.readFileSync(REGISTRY, 'utf8');

group('preamble has rollup swap entry', () => {
  ok("preamble __WASM_SWAPS map contains 'rollup' → '@rollup/wasm-node'",
    /\['rollup',\s*\{[^}]*to:\s*'@rollup\/wasm-node'/.test(preamble));
});

group('registry has rollup swap entry', () => {
  ok("WASM_SWAPS contains rollup → @rollup/wasm-node",
    /from:\s*'rollup'[\s\S]+?to:\s*'@rollup\/wasm-node'/.test(registry));
});

group('parity: count of WASM_SWAPS entries matches preamble map size', () => {
  // Count entries by looking at the `from: '<name>',` literal pattern
  // inside the WASM_SWAPS array (only counts top-level entry-objects,
  // not type-comment `from: string` annotations).
  const wasmSwapsBlock = registry.match(/export const WASM_SWAPS[^=]*=\s*\[[\s\S]+?\n\];/);
  ok('WASM_SWAPS array found in registry', !!wasmSwapsBlock);
  const registryCount = wasmSwapsBlock
    ? (wasmSwapsBlock[0].match(/from:\s*'/g) || []).length
    : 0;

  const preambleBlock = preamble.match(/__WASM_SWAPS\s*=\s*new Map\(\[[\s\S]+?\]\)/);
  ok('preamble __WASM_SWAPS Map found', !!preambleBlock);
  const preambleCount = preambleBlock
    ? (preambleBlock[0].match(/\[\s*'/g) || []).length
    : 0;

  ok(`registry entry count (${registryCount}) === preamble entry count (${preambleCount})`,
    registryCount === preambleCount);
});

summary('preamble-parity-rollup');
