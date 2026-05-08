// Phase 2 A'.1 probe — single-resolver invariant.
//
// Acceptance bar (per Phase 2 charter):
//   resolver-miss path produces hard error visible at /api/_diag/memory
//   (no silent fallback branches remain in code; no fallback to
//   in-supervisor resolver if facet path fails).
//
// This probe combines:
//
//   1. Static check: grep src/ for the strings that mark the legacy
//      paths. The single-resolver invariant requires:
//      - no `shouldUseFacetResolver` method
//      - no `shouldUseFacetPool` method
//      - no `shouldUseBatchFacet` method
//      - no NIMBUS_FACET_RESOLVER / NIMBUS_FACET_NPM_INSTALL /
//        NIMBUS_FACET_NPM_INSTALL_BATCH env-flag reads in installer
//      - no `resolverPath: 'in-supervisor'` literal
//      - no `installFacet.path: 'pool.map' | 'legacy-waves'` literal
//
//   2. Diag-shape check: /api/_diag/memory.counters.resolverPath
//      reports a value drawn from the narrowed taxonomy
//      ({'in-facet' | 'unset'}). Pre-A'.1 the union also includes
//      'in-supervisor'; post-A'.1 it doesn't.
//
//   3. Diag-shape check: /api/_diag/memory.counters.installFacet.path
//      reports a value from {'batch-facet' | 'unset'}.
//
// These are STATIC properties of the rebuild — no install actually
// runs in this probe. The deeper assertion ("the resolver path is
// what we expect during a real install") is covered by the
// long-form-replay probe that follows in cross-wave.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'single-resolver-invariant.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

const BASE = process.env.BASE || 'http://127.0.0.1:8792';
const REPO_ROOT = process.env.REPO_ROOT || path.resolve(HERE, '..', '..', '..', '..');

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

async function main() {
  log("==== A'.1 single-resolver-invariant probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');

  // ── Static check ────────────────────────────────────────────────────
  const installer = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'npm', 'installer.ts'),
    'utf8',
  );

  const forbiddenSubstrings = [
    // method names
    'shouldUseFacetResolver',
    'shouldUseFacetPool',
    'shouldUseBatchFacet',
    // env-flag reads (these are emergency-rollback flags whose
    // existence MEANS a fallback path is wired in)
    'NIMBUS_FACET_RESOLVER',
    'NIMBUS_FACET_NPM_INSTALL',
    'NIMBUS_FACET_NPM_INSTALL_BATCH',
    // legacy taxonomy literals
    "'in-supervisor'",
    "'pool.map'",
    "'legacy-waves'",
    // legacy code paths
    'fetchViaFacetPool',
    'fetchWaves(',
    'buildBatchPayload(',
  ];
  let staticFails = 0;
  for (const sub of forbiddenSubstrings) {
    if (installer.includes(sub)) {
      fail(`src/npm-installer.ts still contains "${sub}" (legacy fallback)`);
      staticFails++;
    } else {
      pass(`src/npm-installer.ts does not contain "${sub}"`);
    }
  }

  // Also assert the diag-counters taxonomy is narrowed.
  const diagCounters = fs.readFileSync(
    path.join(REPO_ROOT, 'src', 'observability', 'diag-counters.ts'),
    'utf8',
  );
  const counterForbidden = [
    "'in-supervisor'",
    "'pool.map'",
    "'legacy-waves'",
  ];
  for (const sub of counterForbidden) {
    if (diagCounters.includes(sub)) {
      fail(`src/diag-counters.ts still contains "${sub}" (legacy taxonomy)`);
      staticFails++;
    } else {
      pass(`src/diag-counters.ts does not contain "${sub}"`);
    }
  }

  // ── Dynamic check: diag taxonomy ────────────────────────────────────
  // A fresh session reports resolverPath='unset' and installFacet.path='unset'
  // until an install runs. The probe asserts the SHAPE — i.e. the only
  // values that ever appear must be from the narrowed unions.
  const r = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' });
  const loc = r.headers.get('location');
  const sid = loc.match(/^\/s\/([^/]+)\/?$/)[1];
  log('SID: ' + sid);
  const dr = await fetch(`${BASE}/s/${sid}/api/_diag/memory`);
  const d = await dr.json();
  const resolverPath = d.counters?.resolverPath;
  const installPath = d.counters?.installFacet?.path;

  log(`counters.resolverPath: ${JSON.stringify(resolverPath)}`);
  log(`counters.installFacet.path: ${JSON.stringify(installPath)}`);

  // Allowed values post-A'.1.
  const allowedResolverPath = new Set(['in-facet', 'unset']);
  const allowedInstallPath = new Set(['batch-facet', 'unset']);
  if (allowedResolverPath.has(resolverPath)) {
    pass(`resolverPath ${JSON.stringify(resolverPath)} ∈ {in-facet, unset}`);
  } else {
    fail(`resolverPath ${JSON.stringify(resolverPath)} not in narrowed union {in-facet, unset}`);
  }
  if (allowedInstallPath.has(installPath)) {
    pass(`installFacet.path ${JSON.stringify(installPath)} ∈ {batch-facet, unset}`);
  } else {
    fail(`installFacet.path ${JSON.stringify(installPath)} not in narrowed union {batch-facet, unset}`);
  }

  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
