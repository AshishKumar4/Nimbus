#!/usr/bin/env bun
// W6.5 functional: applySwaps stays pure — no side-effect into the sink.
// (The supervisor caller is responsible for emitting; tested separately.)

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/facets/wasm-swap-registry.ts');

group('applySwaps does not emit via sink', () => {
  const events = [];
  reg.setRegistryEventSink((e) => events.push(e));
  try {
    const { specs, swaps } = reg.applySwaps({ esbuild: '^0.24.0', react: '*' });
    eq('one swap recorded in return', swaps.length, 1);
    eq('esbuild rewritten in specs', Object.keys(specs).sort(), ['esbuild-wasm', 'react']);
    eq('NO events emitted from applySwaps', events.length, 0);
  } finally {
    reg.setRegistryEventSink(null);
  }
});

summary('applySwaps-pure-no-emit');
