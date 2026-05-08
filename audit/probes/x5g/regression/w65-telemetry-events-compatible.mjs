#!/usr/bin/env bun
// X5G regression: W6.5 RegistryEvent shape unchanged. X5G adds new
// `transitive-skip` events for optional-native-binding skips; these
// must use the EXISTING event variant (no new types).
//
// The existing W6.5 sink keeps working unmodified.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/facets/wasm-swap-registry.ts');

const captured = [];
reg.setRegistryEventSink((e) => captured.push(e));

group('emit existing variants', () => {
  reg.emitRegistryEvent({ type: 'swap', from: 'rollup', to: '@rollup/wasm-node', ctx: 'top' });
  reg.emitRegistryEvent({ type: 'transitive-skip', from: '@rollup/rollup-linux-x64-gnu', reason: 'optional native binding' });
  reg.emitRegistryEvent({ type: 'reject', from: 'sharp', reason: 'native', ctx: 'transitive' });

  eq('3 events captured', captured.length, 3);
  eq('first is swap', captured[0]?.type, 'swap');
  eq('second is transitive-skip', captured[1]?.type, 'transitive-skip');
  eq('third is reject', captured[2]?.type, 'reject');
});

group('no new event variants leaked', () => {
  // The X5G changes must not add new event-type strings beyond
  // {swap, reject, transitive-skip}.
  const validTypes = new Set(['swap', 'reject', 'transitive-skip']);
  for (const e of captured) {
    ok(`event type "${e.type}" is in allowed set`, validTypes.has(e.type));
  }
});

reg.setRegistryEventSink(null);
summary('w65-telemetry-events-compatible');
