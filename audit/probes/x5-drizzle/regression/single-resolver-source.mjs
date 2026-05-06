#!/usr/bin/env bun
// X.5-drizzle regression: single-resolver invariant. Same delegation
// pattern as x5s/x526b — runs the canonical x5f probe to confirm
// `function resolveExports` is still declared exactly once across src/.

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
