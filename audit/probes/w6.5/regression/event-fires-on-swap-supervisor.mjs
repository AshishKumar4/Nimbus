#!/usr/bin/env bun
// W6.5 regression: supervisor swap path emits a `swap` event.
//
// Inspection-based: reads src/npm-installer.ts and asserts the
// applyW6Registry method emits via emitRegistryEvent for each swap.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, group, summary } from '../../w6/_tap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');

const installerSrc = readFileSync(
  path.join(ROOT, 'src', 'npm', 'installer.ts'),
  'utf8',
);

group('npm-installer.ts imports emitRegistryEvent', () => {
  ok(
    'imports emitRegistryEvent from registry',
    /import\s*\{[^}]*emitRegistryEvent[^}]*\}\s*from\s*['"][^'"]*wasm-swap-registry/.test(installerSrc),
  );
});

group('applyW6Registry emits swap events', () => {
  // Find applyW6Registry method body — between its declaration and the next method.
  const m = installerSrc.match(/private\s+applyW6Registry[\s\S]*?(?=\n\s{2}(?:private|public|async|\/\*\*|\}\s*$))/);
  ok('applyW6Registry method found', !!m);
  if (!m) return;
  const body = m[0];

  ok(
    'body emits swap event for each swap',
    /emitRegistryEvent\s*\(\s*\{[^}]*type:\s*['"]swap['"]/.test(body),
  );
  ok(
    'body emits with ctx top',
    /emitRegistryEvent\s*\([\s\S]*?ctx:\s*['"]top['"]/.test(body),
  );
});

group('functional contract: supervisor emit shape matches event-emit-shape', () => {
  // Re-confirm at the registry level that emitting a swap event with the
  // applyW6Registry-shape works.
  import('../../../../src/facets/wasm-swap-registry.ts').then((reg) => {
    const captured = [];
    reg.setRegistryEventSink((e) => captured.push(e));
    try {
      const { specs, swaps } = reg.applySwaps({ esbuild: '*' });
      // Simulate what the supervisor-side caller does:
      for (const s of swaps) {
        reg.emitRegistryEvent({ type: 'swap', from: s.from, to: s.to, ctx: 'top' });
      }
      ok('one swap event captured', captured.length === 1);
      const ev = captured[0];
      ok('event has type swap', ev?.type === 'swap');
      ok('event from === esbuild', ev?.from === 'esbuild');
      ok('event to === esbuild-wasm', ev?.to === 'esbuild-wasm');
      ok('event ctx === top', ev?.ctx === 'top');
    } finally {
      reg.setRegistryEventSink(null);
    }
  });
});

summary('event-fires-on-swap-supervisor');
