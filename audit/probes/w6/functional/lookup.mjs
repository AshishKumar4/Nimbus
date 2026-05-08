// W6 functional: lookupSwap / lookupReject behaviour.

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/functional/lookup');
}

const { lookupSwap, lookupReject } = mod;

group('lookupSwap', () => {
  ok('is a function', typeof lookupSwap === 'function');
  const e = lookupSwap('esbuild');
  ok('hits esbuild', e !== undefined);
  if (e) eq('esbuild → esbuild-wasm', e.to, 'esbuild-wasm');
  ok('miss returns undefined for unknown name', lookupSwap('lodash') === undefined);
  ok('case-sensitive: ESBUILD does not match', lookupSwap('ESBUILD') === undefined);
  ok('miss for already-swapped target', lookupSwap('esbuild-wasm') === undefined);
});

group('lookupReject', () => {
  ok('is a function', typeof lookupReject === 'function');
  const sharp = lookupReject('sharp');
  ok('hits sharp', sharp !== undefined);
  if (sharp) eq('sharp.transitive', sharp.transitive, 'fail');

  const fsev = lookupReject('fsevents');
  ok('hits fsevents', fsev !== undefined);
  if (fsev) eq('fsevents.transitive', fsev.transitive, 'warn');

  ok('miss returns undefined for unknown name', lookupReject('lodash') === undefined);
  ok('case-sensitive', lookupReject('SHARP') === undefined);

  // scoped names work too
  const prismaC = lookupReject('@prisma/client');
  ok('scoped name lookup hits', prismaC !== undefined);
});

summary('w6/functional/lookup');
