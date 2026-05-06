#!/usr/bin/env bun
// X.5-T regression: install-pipeline coverage. Delegates to X.5-F's
// authoritative probe (axios + ts-node + puppeteer-core synth-VFS
// require chain). X.5-T's 3-LOC additive change to __fsMod's return
// object should not regress this — but verify.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const probe = path.resolve(__dirname, '../../x5f/regression/install-pipeline-coverage-shim.mjs');
const r = spawnSync('bun', [probe], {
  encoding: 'utf8',
  cwd: path.resolve(__dirname, '../../../..'),
});
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status ?? 1);
