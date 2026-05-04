// W4 regression probe — re-run the existing install-pipeline-coverage.
//
// W4 must NOT regress fastify / express / ts-jest / redis package visibility.
// The W2.5a fix invariant (children-index sees ALL packages reported by
// npm install) must hold post-W4.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'install-pipeline-coverage-rerun.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== PROBE: install-pipeline-coverage-rerun ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const target = path.resolve(HERE, '../../regression/install-pipeline-coverage.mjs');
const altTarget = path.resolve(HERE, '../../../probes/regression/install-pipeline-coverage.mjs');
const probePath = fs.existsSync(target) ? target : altTarget;
log('Running: ' + probePath);

const r = spawnSync('bun', [probePath], {
  cwd: path.resolve(HERE, '../../../..'),
  stdio: 'inherit',
  timeout: 20 * 60_000,
});

const pass = r.status === 0;
log('');
log('VERDICT: ' + (pass ? 'PASS' : 'FAIL') + ' (exit=' + r.status + ')');
process.exit(pass ? 0 : 1);
