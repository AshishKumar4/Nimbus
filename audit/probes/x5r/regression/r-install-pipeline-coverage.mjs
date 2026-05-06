#!/usr/bin/env bun
// X.5-R regression — install-pipeline coverage shim (X.5-F R1).
//
// Wave R cannot touch the install pipeline (only adds to __streamMod
// in node-shims.ts). Re-running X5F's install-pipeline-coverage-shim
// probe asserts that.

import { ok, summary } from '../../w6/_tap.mjs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');

const r = spawnSync('bun',
  [path.join(ROOT, 'audit/probes/x5f/regression/install-pipeline-coverage-shim.mjs')],
  { encoding: 'utf8' });

ok('install-pipeline-coverage-shim exits 0',
  r.status === 0,
  r.status === 0 ? '' : `code=${r.status}\nstdout:\n${(r.stdout||'').slice(-1500)}\nstderr:\n${(r.stderr||'').slice(-1500)}`);

summary('r-install-pipeline-coverage');
