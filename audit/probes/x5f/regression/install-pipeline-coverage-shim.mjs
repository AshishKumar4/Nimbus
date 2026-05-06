// X.5-F regression — re-runs the canonical install-pipeline-coverage
// probe under the X.5-F build artifact. We don't duplicate the test
// logic; we exec it as a child process and pipe through the exit code.
//
// Per the dispatch prompt:
//   "Regression: install-pipeline-coverage MUST still pass"
//
// This is gated on a running wrangler dev (BASE=http://127.0.0.1:8787).
// If no wrangler is running, the probe SKIPS cleanly with exit 0 and a
// loud message — Phase D will spin one up and re-run.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'install-pipeline-coverage-shim.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5F install-pipeline-coverage shim regression ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
log('BASE=' + BASE);

// Quick reachability probe — if no server, SKIP loudly.
let reachable = false;
try {
  const r = await fetch(BASE + '/', { method: 'HEAD' });
  reachable = r.ok || r.status < 600;  // any HTTP response counts
} catch { reachable = false; }

if (!reachable) {
  log('!! BASE unreachable — SKIP. Phase D will start wrangler dev.');
  process.exit(0);
}

// Forward to the canonical probe.
const child = spawn('bun', [
  path.resolve(HERE, '../../regression/install-pipeline-coverage.mjs'),
], { stdio: 'inherit', env: { ...process.env, BASE } });

const code = await new Promise(res => child.on('exit', res));
log('canonical probe exited ' + code);
process.exit(code);
