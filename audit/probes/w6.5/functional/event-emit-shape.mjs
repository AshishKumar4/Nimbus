#!/usr/bin/env bun
// W6.5 functional: each event variant is JSON-roundtrippable with the documented field set.

import { ok, eq, group, summary } from '../../w6/_tap.mjs';

const reg = await import('../../../../src/facets/wasm-swap-registry.ts');

const captured = [];
reg.setRegistryEventSink((e) => captured.push(e));

try {
  reg.emitRegistryEvent({ type: 'swap', from: 'esbuild', to: 'esbuild-wasm', ctx: 'top' });
  reg.emitRegistryEvent({ type: 'swap', from: 'esbuild', to: 'esbuild-wasm', ctx: 'transitive' });
  reg.emitRegistryEvent({ type: 'reject', from: 'sharp', reason: 'native', ctx: 'top' });
  reg.emitRegistryEvent({ type: 'reject', from: 'sharp', reason: 'native', suggest: 'wasm-vips', ctx: 'transitive' });
  reg.emitRegistryEvent({ type: 'transitive-skip', from: 'fsevents', reason: 'macOS-only' });

  eq('captured 5 events', captured.length, 5);

  group('JSON roundtrip', () => {
    for (const ev of captured) {
      const round = JSON.parse(JSON.stringify(ev));
      eq(`roundtrip ${ev.type}/${ev.from}`, round, ev);
    }
  });

  group('field discipline', () => {
    const swap = captured.find((e) => e.type === 'swap' && e.ctx === 'top');
    eq('swap fields', Object.keys(swap).sort(), ['ctx', 'from', 'to', 'type']);

    const rej = captured.find((e) => e.type === 'reject' && e.suggest);
    eq('reject (with suggest) fields', Object.keys(rej).sort(), ['ctx', 'from', 'reason', 'suggest', 'type']);

    const skip = captured.find((e) => e.type === 'transitive-skip');
    eq('skip fields', Object.keys(skip).sort(), ['from', 'reason', 'type']);
  });

  group('ctx whitelist', () => {
    const ctxs = captured.filter((e) => 'ctx' in e).map((e) => e.ctx);
    for (const c of ctxs) ok(`ctx '${c}' is top|transitive`, c === 'top' || c === 'transitive');
  });
} finally {
  reg.setRegistryEventSink(null);
}

summary('event-emit-shape');
