// W6 functional: parallel/npm-resolve-preamble.ts string contains
// every name in the supervisor's WASM_SWAPS / REJECT_INSTALL.
//
// Background: the resolver function ships into a NimbusFacetPool isolate
// via `fn.toString()`. Lookup tables can't be `import`ed across that
// boundary; they live as inline data inside the preamble string. This
// probe is the snapshot test that catches drift on registry edits.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ok, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREAMBLE_PATH = path.resolve(HERE, '../../../../src/parallel/npm-resolve-preamble.ts');

let registry;
try {
  registry = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/functional/preamble-parity');
}

const { WASM_SWAPS, REJECT_INSTALL } = registry;

let preambleSrc;
try {
  preambleSrc = readFileSync(PREAMBLE_PATH, 'utf8');
} catch (e) {
  ok('preamble file readable', false, e.message);
  summary('w6/functional/preamble-parity');
}

group('preamble exposes swap helpers', () => {
  ok('SHOULD_SWAP function declared in preamble', /function\s+SHOULD_SWAP\s*\(/.test(preambleSrc));
  ok('SHOULD_REJECT_FAIL function declared in preamble', /function\s+SHOULD_REJECT_FAIL\s*\(/.test(preambleSrc));
  ok('SHOULD_WARN_SKIP_TRANSITIVE function declared in preamble', /function\s+SHOULD_WARN_SKIP_TRANSITIVE\s*\(/.test(preambleSrc));
});

// Cross-check the function-name surface used by npm-resolve-facet.ts
// against what the preamble actually declares. Catches the next typo
// at CI rather than at facet runtime (where it would surface as a
// ReferenceError with no source-map).
group('npm-resolve-facet.ts SHOULD_* references all exist in preamble', () => {
  const FACET_PATH = path.resolve(HERE, '../../../../src/npm/resolve-facet.ts');
  let facetSrc;
  try { facetSrc = readFileSync(FACET_PATH, 'utf8'); }
  catch (e) { ok('facet readable', false, e.message); return; }
  // All SHOULD_* identifiers used in the facet
  const used = new Set();
  for (const m of facetSrc.matchAll(/\bSHOULD_[A-Z_]+\b/g)) used.add(m[0]);
  // All SHOULD_* functions declared in the preamble
  const declared = new Set();
  for (const m of preambleSrc.matchAll(/function\s+(SHOULD_[A-Z_]+)\s*\(/g)) declared.add(m[1]);
  for (const name of used) {
    ok(`facet uses SHOULD_${name.replace(/^SHOULD_/, '')} → preamble declares it`, declared.has(name));
  }
});

group('every WASM_SWAPS.from appears in preamble', () => {
  for (const e of WASM_SWAPS) {
    // Match as a quoted token so we don't get accidental substring hits
    const re = new RegExp(`['"\`]${e.from.replace(/[/@]/g, '\\$&')}['"\`]`);
    ok(`${e.from} appears as quoted token in preamble`, re.test(preambleSrc));
    const reTo = new RegExp(`['"\`]${e.to.replace(/[/@]/g, '\\$&')}['"\`]`);
    ok(`${e.to} (target) appears as quoted token in preamble`, reTo.test(preambleSrc));
  }
});

group('every REJECT_INSTALL.from appears in preamble', () => {
  for (const e of REJECT_INSTALL) {
    const re = new RegExp(`['"\`]${e.from.replace(/[/@]/g, '\\$&')}['"\`]`);
    ok(`${e.from} appears as quoted token in preamble`, re.test(preambleSrc));
  }
});

summary('w6/functional/preamble-parity');
