#!/usr/bin/env bun
// X.5-drizzle regression: install-pipeline-coverage probe still
// loadable + scenario list unchanged. Mirrors x5s/x526b/W11/W12 pattern.
// X.5-drizzle modifies only the `frameworkAware` decision in
// detectFrameworkAware — the install-pipeline scenarios must be
// unchanged.

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
