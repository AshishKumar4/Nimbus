#!/usr/bin/env bun
// W6 e2e (PROD-GATED): walk the WASM_SWAPS / REJECT_INSTALL registries
// against a live Nimbus session. For each swap, install <from> and verify
// <to> ends up in node_modules. For each reject, install <from> and verify
// install exits non-zero with the configured reason substring in stderr.
//
// Set NIMBUS_W6_E2E_PROD=1 to run. Default: emits a SKIP banner and
// exits 0 — keeps the local suite network-free.

import { ok, group, summary } from '../_tap.mjs';

if (process.env.NIMBUS_W6_E2E_PROD !== '1') {
  console.log('# w6/e2e/registry-coverage SKIPPED (set NIMBUS_W6_E2E_PROD=1 to run)');
  process.exit(0);
}

let registry;
try {
  registry = await import('../../../../src/facets/wasm-swap-registry.ts');
} catch (e) {
  ok('wasm-swap-registry module exists', false, e.message);
  summary('w6/e2e/registry-coverage');
}

const { WASM_SWAPS, REJECT_INSTALL } = registry;

// TODO: integrate _driver.mjs runProbe to open a prod WS session per
// package and execute `npm install <name>` then verify outcome. Pattern
// matches audit/probes/regression/install-pipeline-coverage.mjs. Held
// off until first prod deploy of W6 (post-merge), since W6 src/ changes
// must be running on the prod end for the contract to be testable.

group('placeholder: registry counts > 0', () => {
  ok(`WASM_SWAPS has ${WASM_SWAPS.length} entries (>=1)`, WASM_SWAPS.length >= 1);
  ok(`REJECT_INSTALL has ${REJECT_INSTALL.length} entries (>=10)`, REJECT_INSTALL.length >= 10);
});

console.log('');
console.log('# NOTE: full prod walk not yet implemented in this probe.');
console.log('# Stub asserts the registry shape. Expand post-merge.');

summary('w6/e2e/registry-coverage');
