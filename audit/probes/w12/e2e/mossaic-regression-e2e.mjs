#!/usr/bin/env bun
// W12 e2e (prod-gated): Mossaic regression against deployed prod.
//
// SKIPs cleanly without NIMBUS_W12_E2E=1.

if (process.env.NIMBUS_W12_E2E !== '1') {
  console.log('# SKIP w12/e2e/mossaic-regression-e2e (NIMBUS_W12_E2E not set)');
  process.exit(0);
}

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..');
const RUNNER = path.join(ROOT, 'audit', 'probes', 'run-mossaic-prod-w2.mjs');

console.log('# running mossaic regression');
const r = spawnSync('bun', [RUNNER], { stdio: 'inherit', cwd: ROOT });
process.exit(r.status ?? 1);
