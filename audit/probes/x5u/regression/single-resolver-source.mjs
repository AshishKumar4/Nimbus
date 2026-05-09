#!/usr/bin/env bun
// X.5-U regression: single-resolver invariant. X.5-U touches ONLY
// src/facet-manager.ts (adds `addStaticReadFileDotfilesAndCompiled`
// helper + one call site) — no resolver-related code change. Delegate
// to X.5-F's authoritative probe to catch any accidental edit ripple.

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
