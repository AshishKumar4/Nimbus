#!/usr/bin/env bun
// X.5-M3 regression: install-pipeline-coverage on node-shims.ts.
// Re-runs the X.5-F shim install-pipeline coverage probe to catch any
// silent shim-shape breakage from the M3 edits.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const probe = path.resolve(__dirname, '../../x5f/regression/install-pipeline-coverage-shim.mjs');
const r = spawnSync('bun', [probe], { encoding: 'utf8', cwd: path.resolve(__dirname, '../../../..') });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status ?? 1);
