#!/usr/bin/env bun
// X.5-26b regression: install-pipeline-coverage probe still loadable
// + scenario list unchanged. Mirrors W11/W12/Z5-build pattern.
// X.5-26b only adds REJECT_INSTALL data; the install pipeline scenarios
// must be unchanged.

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
