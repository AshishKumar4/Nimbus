#!/usr/bin/env bun
// keybindings/run-all — drive every keybinding probe sequentially.
//
// Usage:
//   BASE=https://nimbus.ashishkumarsingh.com bun tests/behavioral/keybindings/run-all.mjs

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const PROBES = [
  'cursor-movement.mjs',
  'edit-ops.mjs',
  'history.mjs',
  'misc.mjs',
];

if (!process.env.BASE) {
  console.error('FATAL: BASE env required');
  process.exit(2);
}

let failed = 0;
for (const p of PROBES) {
  console.log(`\n────────── ${p} ──────────`);
  const r = spawnSync('bun', [join(here, p)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) failed++;
}

console.log(`\n──────────`);
console.log(failed === 0
  ? `keybindings: ALL ${PROBES.length} probe files passing`
  : `keybindings: ${failed}/${PROBES.length} probe files failing`);
process.exit(failed === 0 ? 0 : 1);
