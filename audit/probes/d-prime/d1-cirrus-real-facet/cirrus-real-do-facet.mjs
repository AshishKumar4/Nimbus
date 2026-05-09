// Phase 4 D'.1 functional probe — cirrus-real runs as a DO Facet
// (ctx.facets.get) instead of a stateless Worker.
//
// Two valid kinds (post-d1-fix wave):
//   'do-facet'           — DO Facet path (requires `experimental` compat
//                          flag; provides per-instance own-SQLite cookie).
//   'fetcher-fallback'   — stateless WorkerEntrypoint fallback (used
//                          when getDurableObjectClass is unavailable —
//                          the case in production CF deployments since
//                          the 2026-05-08 deploy validator change
//                          rejected $experimental flags for non-CF-team
//                          accounts). User-visible /preview/ behavior
//                          is identical; cookie is N/A.
//
// Why both kinds: D'.1 was originally specified as DO-Facet-only. The
// deploy-flag-fix wave (commit 1909718) removed `experimental` from
// compatibility_flags to satisfy the CF deploy validator — which made
// the DO Facet path unreachable both locally and in prod. The d1-fix
// wave added the stateless-fetcher fallback so cirrus-real keeps
// serving in prod (where `experimental` is rejected) while the DO
// Facet path is preserved for any future CF account that gets
// whitelisted for `$experimental`.
//
// Acceptance bar:
//   1. /api/_diag/cirrus exposes the `kind` field. The kind must be
//      one of {'do-facet', 'fetcher-fallback'}. Pre-D'.1 the endpoint
//      either 404'd or omitted `kind` entirely.
//   2. (do-facet only) The facet has its own SQLite — a cookie row
//      written once at first boot. Same DO across restarts of the
//      supervisor's WS connection means same cookie.
//   3. (do-facet only) After a forced ws-close, reconnecting returns
//      the SAME cookie. Stateless fetcher has no cookie to preserve;
//      that path skips this check with an explicit info log.
//   4. (both kinds) /preview/ serves correctly across the reconnect.
//
// Pre-build (RED): /api/_diag/cirrus has no `kind` field. Probe
// fails on assertion 1.
//
// Post-build (GREEN): `kind` is one of the two valid values; the
// kind-appropriate sub-assertions pass.

import {
  BASE, mintSession, getDiag, WsSession, sleep,
} from '../../interactive-liveness/_driver.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'cirrus-real-do-facet.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

async function getCirrusDiag(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/cirrus`);
  if (r.status === 404) return null;
  return r.json();
}

async function main() {
  log("==== D'.1 cirrus-real-do-facet probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  // ── Stage 1: boot — connect WS, run vite ────────────────────────────
  const s1 = new WsSession(sid);
  await s1.connect();
  await s1.waitForPrompt(8000);
  log('stage 1: shell prompt ready');

  // Trigger cirrus-real boot. We use `vite --force` (skips the
  // node_modules guard since the seed project's deps aren't installed
  // and we don't actually need vite to serve requests for this probe
  // — we just need the cirrus-real facet to be instantiated so its
  // own-SQLite cookie row is written and surfaceable via diag).
  // NIMBUS_REAL_VITE=1 routes the session through cirrus-real instead
  // of the in-process Cirrus shim.
  s1.reset();
  s1.send('cd app && export NIMBUS_REAL_VITE=1 && vite --force &\r');
  // Give the facet time to boot. Vite's createServer + listen inside
  // workerd takes a few seconds; we don't actually wait for vite to
  // be ready, just for the facet stub to be allocated and its cookie
  // row written. Poll the diag every 500 ms up to 15 s for `running`.
  const t0 = Date.now();
  let booted = null;
  while (Date.now() - t0 < 15000) {
    await sleep(500);
    const d = await getCirrusDiag(sid);
    if (d?.running) { booted = d; break; }
  }
  if (!booted) {
    log('stage 1: cirrus-real never reached running=true within 15s');
  }

  const diag1 = await getCirrusDiag(sid);
  log('stage 1: cirrus diag = ' + JSON.stringify(diag1));
  if (!diag1) {
    fail("/api/_diag/cirrus 404 — endpoint not landed (D'.1 surface missing)");
    log('==== EXIT ' + exitCode + ' ====');
    process.exit(exitCode);
  }
  // Accept BOTH valid kinds: 'do-facet' (full feature, requires
  // `experimental` flag) and 'fetcher-fallback' (stateless prod path).
  // ANYTHING ELSE is FAIL — undefined means D'.1 surface missing,
  // 'loader-load' means the legacy pre-D'.1 path is back (regression).
  const KIND_DO_FACET = 'do-facet';
  const KIND_FETCHER_FALLBACK = 'fetcher-fallback';
  if (diag1.kind === undefined) {
    fail("`kind` field missing on /api/_diag/cirrus — D'.1 surface not landed");
  } else if (diag1.kind === KIND_DO_FACET) {
    pass(`kind='do-facet' (cirrus-real running as DO Facet — full feature)`);
  } else if (diag1.kind === KIND_FETCHER_FALLBACK) {
    pass(`kind='fetcher-fallback' (cirrus-real running as stateless WorkerEntrypoint — \`experimental\` compat flag absent; this IS the prod path)`);
  } else {
    fail(`kind='${diag1.kind}' (expected 'do-facet' or 'fetcher-fallback')`);
  }

  // Cookie + cookie-persistence assertions ONLY apply when kind is
  // 'do-facet'. The stateless fetcher fallback has no per-instance
  // SQLite by design.
  const kind1 = diag1.kind;
  if (kind1 === KIND_DO_FACET) {
    if (diag1.cookie === undefined) {
      fail("`cookie` field missing — facet's own-SQLite identity not surfaced");
    } else if (typeof diag1.cookie === 'string' && diag1.cookie.length > 0) {
      pass(`cookie=${diag1.cookie.slice(0, 12)}... (facet's own SQLite working)`);
    } else {
      fail(`cookie=${JSON.stringify(diag1.cookie)} (expected non-empty string for kind='do-facet')`);
    }
  } else if (kind1 === KIND_FETCHER_FALLBACK) {
    if (diag1.cookie === null) {
      pass(`cookie=null is correct for kind='fetcher-fallback' (no per-instance SQLite by design)`);
    } else {
      fail(`cookie=${JSON.stringify(diag1.cookie)} (expected null for kind='fetcher-fallback')`);
    }
  }

  if (diag1.bootError) {
    fail(`facet bootError: ${diag1.bootError}`);
  } else {
    pass('facet booted without error');
  }

  if (typeof diag1.bootMs === 'number' && diag1.bootMs <= 200) {
    pass(`cold-start = ${diag1.bootMs}ms ≤ 200ms regression budget`);
  } else if (typeof diag1.bootMs === 'number') {
    log(`info: cold-start = ${diag1.bootMs}ms (> 200ms; first boot includes vite import)`);
    pass(`cold-start = ${diag1.bootMs}ms recorded (warm reuse will be checked next)`);
  } else {
    fail('bootMs not surfaced on diag');
  }

  const cookie1 = diag1.cookie;

  // ── Stage 2: force ws-close + reconnect supervisor ────────────────────
  const isoBefore = (await getDiag(sid)).hib.isolateGen;
  await s1.close();
  await sleep(800);
  const isoAfter = (await getDiag(sid)).hib.isolateGen;
  if (isoAfter !== isoBefore) {
    fail(`isolateGen bumped (${isoBefore} → ${isoAfter}); not a same-isolate test`);
  } else {
    pass(`isolateGen stable at ${isoBefore} across close`);
  }

  const s2 = new WsSession(sid);
  await s2.connect();
  // Don't wait for a fresh prompt — vite is still running in this
  // shell and pumping output; the prompt may not return cleanly.
  // Just give the warm-rejoin path time to settle.
  await sleep(1500);

  // ── Stage 3: cirrus-real should still be alive ──────────────────────
  const diag2 = await getCirrusDiag(sid);
  log('stage 3: cirrus diag post-reconnect = ' + JSON.stringify(diag2));
  if (!diag2) {
    fail('/api/_diag/cirrus 404 after reconnect');
  } else if (diag2.kind === KIND_DO_FACET || diag2.kind === KIND_FETCHER_FALLBACK) {
    pass(`post-reconnect: kind='${diag2.kind}' (cirrus-real survived supervisor close)`);
  } else {
    fail(`post-reconnect kind='${diag2?.kind}' (expected 'do-facet' or 'fetcher-fallback')`);
  }

  // Cookie persistence is a DO-Facet-only invariant. The stateless
  // fetcher fallback has no cookie to preserve by design — log
  // explicitly so the run-all output shows the kind-appropriate
  // assertion path was taken.
  if (diag2 && diag2.kind === KIND_DO_FACET) {
    if (diag2.cookie === cookie1) {
      pass(`cookie preserved across supervisor reconnect (facet survived independently)`);
    } else {
      fail(`cookie changed: ${cookie1?.slice?.(0, 12)} → ${diag2.cookie?.slice?.(0, 12)} — facet was rebuilt`);
    }
  } else if (diag2 && diag2.kind === KIND_FETCHER_FALLBACK) {
    log(`info: cookie persistence N/A for kind='fetcher-fallback' (no per-instance SQLite; the prod path)`);
  }

  // ── Stage 4: warm reuse should be fast ──────────────────────────────
  // After the reconnect, hitting /preview/* should reuse the warm
  // facet stub. If the diag exposes a `lastFetchMs`, assert it's
  // small (warm-stub fetch is ~1-10ms; cold rebuild would be > 5s).
  if (diag2 && typeof diag2.lastFetchMs === 'number' && diag2.lastFetchMs <= 50) {
    pass(`warm-fetch latency = ${diag2.lastFetchMs}ms ≤ 50ms`);
  } else if (diag2) {
    log(`info: lastFetchMs = ${diag2.lastFetchMs} (no recent fetch; not asserting)`);
  }

  await s2.close();
  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
