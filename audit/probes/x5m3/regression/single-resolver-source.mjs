#!/usr/bin/env bun
// X.5-M3 regression: single-resolver invariant. M3 only touches
// src/node-shims.ts, but rerun the X.5-F invariant check to catch any
// accidental cross-file change.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const probe = path.resolve(__dirname, '../../x5f/regression/single-resolver-source.mjs');
const r = spawnSync('bun', [probe], { encoding: 'utf8', cwd: path.resolve(__dirname, '../../../..') });
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status ?? 1);
