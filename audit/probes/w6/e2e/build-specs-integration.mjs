// W6 e2e: integrated applySwaps + findRejects flow simulating
// what buildSpecs() will do once wired (plan §4.1).

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/e2e/build-specs-integration');
}

const { applySwaps, findRejects, formatSwapNotice, formatRejectError } = mod;

group('mixed swap + reject + neutral input', () => {
  const input = {
    esbuild: '^0.19',   // swap → esbuild-wasm
    sharp: '*',          // reject (fail)
    prisma: '^5',        // reject (fail)
    lodash: '^4',        // neutral
  };

  // Step 1: swap
  const { specs: swapped, swaps } = applySwaps(input);
  eq('one swap recorded', swaps.length, 1);
  if (swaps[0]) eq('swap from is esbuild', swaps[0].from, 'esbuild');
  ok('esbuild-wasm in specs', 'esbuild-wasm' in swapped);
  ok('lodash preserved', swapped.lodash === '^4');

  // Step 2: reject
  const rejects = findRejects(swapped, 'top');
  eq('two rejects', rejects.length, 2);
  const rejectFroms = new Set(rejects.map(r => r.from));
  ok('sharp rejected', rejectFroms.has('sharp'));
  ok('prisma rejected', rejectFroms.has('prisma'));

  // Step 3: notices and error messages
  const swapNotice = formatSwapNotice(swaps[0]);
  ok('swap notice contains both names', swapNotice.includes('esbuild') && swapNotice.includes('esbuild-wasm'));
  const rejectMsg = formatRejectError(rejects);
  ok('reject message mentions sharp', rejectMsg.includes('sharp'));
  ok('reject message mentions prisma', rejectMsg.includes('prisma'));
  ok('reject message has summary count "2"', rejectMsg.includes('2'));
});

group('all-clean input is fully passthrough', () => {
  const input = { lodash: '^4', react: '^18', fastify: '^4' };
  const { specs, swaps } = applySwaps(input);
  eq('specs unchanged', specs, input);
  eq('no swaps', swaps, []);
  eq('no rejects', findRejects(specs, 'top'), []);
});

group('all-reject input throws via formatter', () => {
  const input = { sharp: '*', prisma: '*', puppeteer: '*' };
  const { specs } = applySwaps(input);
  const rejects = findRejects(specs, 'top');
  eq('three rejects', rejects.length, 3);
  const msg = formatRejectError(rejects);
  ok('msg has summary 3', msg.includes('3'));
  ok('msg has all three names',
    msg.includes('sharp') && msg.includes('prisma') && msg.includes('puppeteer'));
});

group('user-visible error includes suggestions where present', () => {
  const input = { sharp: '*' };
  const rejects = findRejects(input, 'top');
  const msg = formatRejectError(rejects);
  ok('contains "try" or "suggestion"',
    msg.toLowerCase().includes('try') || msg.toLowerCase().includes('suggest'));
});

summary('w6/e2e/build-specs-integration');
