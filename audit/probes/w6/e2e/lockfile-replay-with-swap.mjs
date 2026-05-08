// W6 e2e: cold install with a swap candidate writes the swap target
// into the lockfile; replay (warm install with same lockfile) does
// NOT re-emit the [swap] notice (the deps are already swapped).
//
// This is a pure-logic probe: we simulate the buildSpecs ↔ lockfile
// interaction without touching a real installer. The contract:
//   - lockfile records swap target (esbuild-wasm)
//   - on replay, applySwaps sees an already-swapped key and is a no-op
//   - on replay, no swap notice gets logged

import { ok, eq, group, summary } from '../_tap.mjs';

let mod;
try {
  mod = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/e2e/lockfile-replay-with-swap');
}

const { applySwaps, formatSwapNotice } = mod;

group('cold → swap fires; warm → silent', () => {
  // User's package.json
  const userDeps = { esbuild: '^0.19', lodash: '^4' };

  // === COLD INSTALL ===
  const cold = applySwaps(userDeps);
  eq('cold: one swap recorded', cold.swaps.length, 1);
  // Lockfile is built from cold.specs (the post-swap map)
  const lockfile = { ...cold.specs };
  ok('lockfile has esbuild-wasm', 'esbuild-wasm' in lockfile);
  ok('lockfile does NOT have esbuild', !('esbuild' in lockfile));

  // Cold-time notice was emitted
  const coldNotice = cold.swaps.map(formatSwapNotice);
  eq('cold notice count', coldNotice.length, 1);

  // === WARM INSTALL (replay from lockfile) ===
  // The installer's flow on warm: lockfile contents become the spec map.
  // applySwaps runs again on those (idempotency contract).
  const warm = applySwaps(lockfile);
  eq('warm: zero swaps recorded (idempotent)', warm.swaps, []);
  eq('warm: specs unchanged', warm.specs, lockfile);
  // No notices on warm replay
  const warmNotice = warm.swaps.map(formatSwapNotice);
  eq('warm notice count', warmNotice.length, 0);
});

group('user package.json source-of-truth preserved', () => {
  // Documentation contract: even though the lockfile says esbuild-wasm,
  // the user's package.json should still say "esbuild" — the swap
  // target leaks into the lockfile only. This is enforced by step 7
  // of the build plan ('updatePackageJson honours swap'). Here we
  // assert the principle: applySwaps does NOT mutate its input.
  const userDeps = { esbuild: '^0.19' };
  const before = JSON.stringify(userDeps);
  applySwaps(userDeps);
  eq('input not mutated', JSON.stringify(userDeps), before);
});

summary('w6/e2e/lockfile-replay-with-swap');
