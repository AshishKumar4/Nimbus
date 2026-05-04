// W6 regression: both resolver paths (legacy in-supervisor `resolveTree`
// and facet-isolate `resolveTreeInFacet` via preamble) make identical
// swap/reject decisions for a fixed input set.
//
// We don't actually run the resolvers (they need network + facets); we
// extract the decision *rules* from each path and assert they reach the
// same verdict on a curated input set. Catches drift where the supervisor
// registry is updated but the preamble is not.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ok, eq, group, summary } from '../_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREAMBLE_PATH = path.resolve(HERE, '../../../../src/parallel/npm-resolve-preamble.ts');

let registry, resolverMod;
try {
  registry = await import('../../../../src/wasm-swap-registry.ts');
  resolverMod = await import('../../../../src/npm-resolver.ts');
} catch (e) {
  ok('modules importable', false, e.message);
  summary('w6/regression/resolver-paths-symmetric');
}

const { WASM_SWAPS, REJECT_INSTALL, lookupSwap, lookupReject } = registry;
const { shouldSkipPackage } = resolverMod;

let preambleSrc;
try {
  preambleSrc = readFileSync(PREAMBLE_PATH, 'utf8');
} catch (e) {
  ok('preamble readable', false, e.message);
  summary('w6/regression/resolver-paths-symmetric');
}

// Build a "what would the preamble decide?" function by inspecting source.
// The preamble exposes SHOULD_SWAP and (a reject helper). We can't exec
// it directly (it's a TS string with workerd-isolate semantics). Instead
// we verify: every name the supervisor registry would swap/reject appears
// quoted in the preamble — i.e., the preamble has the data needed to
// make the same decision. (Stronger checks are in functional/preamble-parity.)

const TEST_INPUT = [
  // Should swap:
  'esbuild',
  // Should reject (fail):
  'sharp', 'prisma', 'puppeteer', 'bcrypt', 'argon2',
  // Should reject (warn — transitive becomes silent skip):
  'fsevents', 'bufferutil', 'utf-8-validate',
  // Should pass through:
  'lodash', 'react', 'fastify',
  // Should be SKIP_PACKAGES-pruned:
  'typescript', 'eslint', 'prettier',
];

group('per-name decision parity', () => {
  for (const name of TEST_INPUT) {
    const swap = lookupSwap(name);
    const reject = lookupReject(name);
    const skip = shouldSkipPackage(name);

    // Preamble must have data for the decision:
    if (swap) {
      const re = new RegExp(`['"\`]${name}['"\`]`);
      ok(`${name}: preamble has swap entry`, re.test(preambleSrc));
    } else if (reject) {
      const re = new RegExp(`['"\`]${name}['"\`]`);
      ok(`${name}: preamble has reject entry`, re.test(preambleSrc));
    } else if (skip) {
      // skip names are in __SKIP_PACKAGES inside preamble
      const re = new RegExp(`['"\`]${name}['"\`]`);
      ok(`${name}: preamble has skip entry`, re.test(preambleSrc));
    } else {
      // pass-through names need NOT be in preamble
      ok(`${name}: pass-through (no entry needed)`, true);
    }

    // Sanity: a name should not be in BOTH swap and reject (covered by registry-shape;
    // re-asserted here as a parity safety net).
    ok(`${name}: not in both swap and reject`, !(swap && reject));
  }
});

group('counts roughly match', () => {
  // Every WASM_SWAPS entry must result in 2 quoted tokens (from + to).
  let swapTokens = 0;
  for (const e of WASM_SWAPS) {
    const reFrom = new RegExp(`['"\`]${e.from.replace(/[/@]/g, '\\$&')}['"\`]`, 'g');
    const reTo = new RegExp(`['"\`]${e.to.replace(/[/@]/g, '\\$&')}['"\`]`, 'g');
    swapTokens += (preambleSrc.match(reFrom) || []).length;
    swapTokens += (preambleSrc.match(reTo) || []).length;
  }
  ok(`preamble has at least ${WASM_SWAPS.length * 2} swap-related quoted tokens`, swapTokens >= WASM_SWAPS.length * 2);
});

summary('w6/regression/resolver-paths-symmetric');
