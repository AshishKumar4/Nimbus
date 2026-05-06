#!/usr/bin/env bun
// X.5-26b regression: single-resolver invariant. Same probe as
// X.5-F/G/C/J/L/M/NPQO/Z3/Z5-build/M3 — `function resolveExports`
// declared exactly once across src/.
// X.5-26b touches only data files (src/wasm-swap-registry.ts and
// src/parallel/npm-resolve-preamble.ts), not code, so this should
// always pass — but rerun to catch accidental edit ripple.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const probe = path.resolve(__dirname, '../../x5f/regression/single-resolver-source.mjs');
const r = spawnSync('bun', [probe], {
  encoding: 'utf8',
  cwd: path.resolve(__dirname, '../../../..'),
});
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status ?? 1);
