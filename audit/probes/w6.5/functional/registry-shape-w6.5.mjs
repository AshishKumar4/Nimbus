#!/usr/bin/env bun
// W6.5 functional: new registry exports for telemetry hook are present and well-typed.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/facets/wasm-swap-registry.ts');

group('telemetry hook exports', () => {
  ok('exports setRegistryEventSink', typeof reg.setRegistryEventSink === 'function');
  ok('exports emitRegistryEvent', typeof reg.emitRegistryEvent === 'function');
  ok('exports getRegistryEventSink', typeof reg.getRegistryEventSink === 'function');
  ok('exports getSinkThrowCount', typeof reg.getSinkThrowCount === 'function');
});

group('default sink state', () => {
  // Reset (idempotent — tests don't share isolate, but be safe).
  reg.setRegistryEventSink(null);
  ok('default sink is null', reg.getRegistryEventSink() === null);
  eq('initial throw count is 0', reg.getSinkThrowCount(), 0);
});

group('event variants documented', () => {
  // The events are TS-typed at compile time. Ensure runtime emit accepts each
  // variant without throwing. (Sink null → no-op.)
  reg.emitRegistryEvent({ type: 'swap', from: 'esbuild', to: 'esbuild-wasm', ctx: 'top' });
  reg.emitRegistryEvent({ type: 'reject', from: 'sharp', reason: 'native', ctx: 'top' });
  reg.emitRegistryEvent({ type: 'reject', from: 'sharp', reason: 'native', suggest: 'wasm-vips', ctx: 'transitive' });
  reg.emitRegistryEvent({ type: 'transitive-skip', from: 'fsevents', reason: 'optional native' });
  ok('all four variants emit cleanly', true);
});

summary('registry-shape-w6.5');
