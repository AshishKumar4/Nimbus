// X.5-F e2e probe driver — installs each of the 7 X.5-F-relevant
// packages on a freshly-spawned local wrangler dev session and probes
// the resolution behavior we care about.
//
// REQUIRES: a running wrangler dev at BASE (default http://127.0.0.1:8787).
// Phase D wraps this with a wrangler-dev launcher.
//
// Per package, we record:
//   - install ok/fail
//   - resolver-facet message (key signal: "0 resolved" vs "N resolved")
//   - require() smoke result
//   - whether the error is the OLD shape ("Cannot find module 'X' (from /home/user/app)")
//     or a NEW shape (ESM-only loud reject, native-binding loud reject, etc.)
//
// Output: audit/probes/x5f/e2e/run-x5f-packages.txt + per-pkg
//         <pkg>.out.txt under the same dir.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProbe } from '../../_driver.mjs';

// Run a smoke script INSIDE /home/user/app so require() walks up to
// the right node_modules (mirrors run-packages-local.mjs:78-84). The
// shared driver's nodeEvalBase64 helper writes to /tmp, which would
// make `require('@radix-ui/react-dialog')` fail with the wrong-shape
// "(from /tmp)" error after install actually succeeded.
function inAppRequireBase64(jsSource) {
  const id = 'x5fsmoke_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const b64 = Buffer.from(jsSource, 'utf8').toString('base64');
  const write = `node -e "require('fs').writeFileSync('/home/user/app/.${id}.js', Buffer.from(process.argv[1],'base64').toString('utf8'))" '${b64}'`;
  const run = `cd /home/user/app && node .${id}.js`;
  return write + ' && ' + run;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'run-x5f-packages.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s + '\n'); console.log(s); };

log('==== X5F e2e packages probe ====');
log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
log('==== BASE: ' + (process.env.BASE || 'https://nimbus.ashishkmr472.workers.dev') + ' ====');

const SCENARIOS = [
  { id: 'webpack',              cluster: 'R1', install: 'webpack',              probeJs: `const w = require('webpack'); console.log('typeof:', typeof w, 'webpackKeys:', Object.keys(w||{}).slice(0,5).join(','));` },
  { id: 'rollup',               cluster: 'R1', install: 'rollup',               probeJs: `try { const r = require('rollup'); console.log('typeof:', typeof r, 'rollupKeys:', Object.keys(r||{}).slice(0,5).join(',')); } catch(e){ console.log('require-throw:', e.message); }` },
  { id: 'parcel',               cluster: 'R1', install: 'parcel',               probeJs: `try { const p = require('parcel'); console.log('typeof:', typeof p); } catch(e){ console.log('require-throw:', e.message); }` },
  { id: 'radix-react-dialog',   cluster: 'R2', install: '@radix-ui/react-dialog', probeJs: `try { const m = require('@radix-ui/react-dialog'); console.log('keys:', Object.keys(m||{}).slice(0,8).join(',')); } catch(e){ console.log('require-throw:', e.message); }` },
  { id: 'framer-motion',        cluster: 'R2', install: 'framer-motion',        probeJs: `try { const m = require('framer-motion'); console.log('keys:', Object.keys(m||{}).slice(0,8).join(',')); } catch(e){ console.log('require-throw:', e.message); }` },
  { id: 'ts-jest',              cluster: 'R2', install: 'ts-jest',              probeJs: `try { const m = require('ts-jest'); console.log('typeof:', typeof m); } catch(e){ console.log('require-throw:', e.message); }` },
  { id: 'nuxt',                 cluster: 'R3', install: 'nuxt',                 probeJs: `try { const m = require('nuxt'); console.log('typeof:', typeof m); } catch(e){ console.log('require-throw:', e.message); }` },
];

// Helper — classify a probe output.
//   ✅  = require() succeeded (saw 'typeof:' or 'keys:')
//   ⛔  = REJECT_INSTALL or "npm install rejected:" loud reject path
//         (W6 healthy outcome). require-throw AFTER a loud-reject is
//         expected; the package isn't installed.
//   ⚠️  = require-throw (still failing for a non-rejected install)
//   ❌  = the OLD shape: "Cannot find module 'X' (from /home/user/app)"
//         OCCURRING WITHOUT a preceding loud-reject — i.e. the install
//         silently failed, like the pre-X.5-F state.
//   ?   = inconclusive
function classify(scenario, log) {
  // Loud-reject takes priority — a healthy W6 outcome.
  const rejected = /npm install rejected:|REJECT_INSTALL|RegistryRejectError/.test(log);
  if (rejected) return '⛔';

  if (/typeof:|keys:/.test(log)) return '✅';

  const oldShape = new RegExp(`Cannot find module '${scenario.install.replace('@','\\@')}' \\(from /home/user/app\\)`);
  if (oldShape.test(log)) return '❌-OLD-SHAPE';

  if (/require-throw:/.test(log)) {
    // Honest-blocker categories
    if (/file was not pre-bundled/i.test(log)) return '⚠-PREBUNDLE';
    if (/ESM-only|TLA|top-level await/i.test(log)) return '⚠-ESM';
    return '⚠';
  }
  return '?';
}

const results = [];
const concurrent = Number(process.env.X5F_E2E_CONCURRENCY) || 1;

async function runOne(sc) {
  const perFile = path.join(HERE, sc.id + '.out.txt');
  fs.writeFileSync(perFile, '');
  const r = await runProbe(`x5f-${sc.id}`, [
    { kind: 'cmd', cmd: `cd app && npm install ${sc.install}`, timeoutMs: 240_000 },
    { kind: 'cmd', cmd: inAppRequireBase64(sc.probeJs), timeoutMs: 30_000 },
  ], { artifactPath: perFile, settleMs: 3000 });
  const body = fs.readFileSync(perFile, 'utf8');
  const verdict = classify(sc, body);
  log(`  ${sc.id} (${sc.cluster}): ${verdict}`);
  return { ...sc, verdict, ok: r.ok };
}

if (concurrent === 1) {
  for (const sc of SCENARIOS) results.push(await runOne(sc));
} else {
  // simple bounded concurrency
  let i = 0;
  const workers = Array.from({ length: concurrent }, async () => {
    while (i < SCENARIOS.length) {
      const idx = i++;
      results[idx] = await runOne(SCENARIOS[idx]);
    }
  });
  await Promise.all(workers);
}

log('');
log('=========================================');
log('SUMMARY:');
const pass = results.filter(r => r.verdict === '✅').length;
const loudReject = results.filter(r => r.verdict === '⛔').length;
const honestBlock = results.filter(r => /^⚠/.test(r.verdict)).length;
const oldShape = results.filter(r => r.verdict.includes('OLD-SHAPE')).length;
const inconclusive = results.filter(r => r.verdict === '?').length;
for (const r of results) {
  log('  ' + r.verdict + '  ' + r.id + ' (' + r.cluster + ')');
}
log('-----------------------------------------');
log(`✅ ${pass}   ⛔ ${loudReject}   ⚠ ${honestBlock}   ❌-OLD-SHAPE ${oldShape}   ? ${inconclusive}`);

// X.5-F done criterion: ≥4 of 7 turn ✅, AND zero remain in OLD-SHAPE.
const okFlips = pass >= 4;
const noOldShape = oldShape === 0;
log('');
log('done-criterion[≥4 ✅]:        ' + (okFlips ? 'PASS' : 'FAIL'));
log('done-criterion[no OLD-SHAPE]: ' + (noOldShape ? 'PASS' : 'FAIL'));
const overall = okFlips && noOldShape;
log('OVERALL: ' + (overall ? 'PASS' : 'FAIL'));
process.exit(overall ? 0 : 1);
