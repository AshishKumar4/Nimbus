#!/usr/bin/env bun
// W6.5 functional: setRegistryEventSink replaces the sink; null silences;
// throwing sink is caught and counted but never propagates.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/wasm-swap-registry.ts');

group('install + replace + clear', () => {
  reg.setRegistryEventSink(null);
  const a = [];
  reg.setRegistryEventSink((e) => a.push(e));
  reg.emitRegistryEvent({ type: 'swap', from: 'x', to: 'y', ctx: 'top' });
  eq('sink-a captured 1', a.length, 1);

  const b = [];
  reg.setRegistryEventSink((e) => b.push(e));
  reg.emitRegistryEvent({ type: 'swap', from: 'p', to: 'q', ctx: 'top' });
  eq('sink-a still 1 (replaced)', a.length, 1);
  eq('sink-b captured 1', b.length, 1);

  reg.setRegistryEventSink(null);
  reg.emitRegistryEvent({ type: 'swap', from: 'm', to: 'n', ctx: 'top' });
  eq('sink-a still 1 (cleared)', a.length, 1);
  eq('sink-b still 1 (cleared)', b.length, 1);
});

group('throwing sink is contained', () => {
  reg.setRegistryEventSink(null);
  const before = reg.getSinkThrowCount();
  reg.setRegistryEventSink(() => { throw new Error('sink-failure-by-design'); });
  let propagated = false;
  try {
    reg.emitRegistryEvent({ type: 'swap', from: 'x', to: 'y', ctx: 'top' });
  } catch {
    propagated = true;
  }
  ok('throw did NOT propagate to caller', !propagated);
  ok('throw count incremented', reg.getSinkThrowCount() > before);
  reg.setRegistryEventSink(null);
});

summary('sink-injection');
