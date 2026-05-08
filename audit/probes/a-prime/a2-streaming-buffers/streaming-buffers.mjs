// Phase 2 A'.2 probe — streaming-buffers heap component.
//
// Acceptance bar (per Phase 2 charter):
//   heap.breakdown.streamingBuffersBytes ≤ 1 MiB peak under install
//   of a 33-pkg cohort top-5 (W7 coverage closes).
//
// Background — what this probe enforces:
//
// The supervisor mediates byte-flow between facets (npm-resolve,
// npm-install-batch, pre-bundle, vite-dev) and the VFS / SQLite cache
// layer. Every RPC method on SupervisorRPC that takes a payload (or
// returns one) holds bytes in supervisor heap from RPC entry to RPC
// exit. Pre-A'.2 those bytes were INVISIBLE — the C'.1 estimator's
// breakdown didn't attribute a slot to "in-flight RPC payloads".
//
// The W7 streaming primitive (src/_shared/w7-frame.ts) already
// established the contract for ReadableStream-over-RPC bytes that
// flow with backpressure rather than buffering. A'.2 closes the
// observability gap: any RPC call that buffers MORE than the W7
// streaming guarantee is now visible in the breakdown as
// streamingBuffersBytes.
//
// The probe asserts:
//   1. /api/_diag/memory.heap.breakdown.streamingBuffersBytes is
//      present (the new attribution slot exists).
//   2. At idle (no install in flight): streamingBuffersBytes ≤ 1 MiB.
//   3. The breakdown sum-equals-total invariant still holds with
//      the new component included.
//
// A 33-pkg-install peak-bound assertion is OUT OF SCOPE for this
// probe (it requires driving a full install — too slow for the
// per-sub-phase gate). The long-form-replay smoke test verifies
// no heap regression under load.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'streaming-buffers.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

const BASE = process.env.BASE || 'http://127.0.0.1:8792';
let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

const ONE_MIB = 1 * 1024 * 1024;

async function mintSession() {
  const r = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' });
  const loc = r.headers.get('location');
  const m = loc.match(/^\/s\/([^/]+)\/?$/);
  if (!m) throw new Error(`unexpected Location: ${loc}`);
  return m[1];
}

async function getDiag(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/memory`);
  return r.json();
}

async function main() {
  log("==== A'.2 streaming-buffers probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  const d = await getDiag(sid);
  log('heap.breakdown = ' + JSON.stringify(d.heap?.breakdown, null, 2));

  if (!d.heap?.breakdown) {
    fail("/api/_diag/memory missing heap.breakdown — Phase 1 C'.1 not landed?");
    log('==== EXIT ' + exitCode + ' ====');
    process.exit(exitCode);
  }

  // ── Assertion 1: the new component exists ─────────────────────────────
  if ('streamingBuffersBytes' in d.heap.breakdown) {
    pass('breakdown.streamingBuffersBytes exists');
  } else {
    fail("breakdown.streamingBuffersBytes is missing — A'.2 attribution slot not added");
  }

  // ── Assertion 2: idle ≤ 1 MiB ─────────────────────────────────────────
  const sb = d.heap.breakdown.streamingBuffersBytes;
  if (typeof sb === 'number' && sb <= ONE_MIB) {
    pass(`streamingBuffersBytes = ${sb} bytes ≤ 1 MiB at idle`);
  } else if (typeof sb !== 'number') {
    fail(`streamingBuffersBytes = ${JSON.stringify(sb)} (expected a number)`);
  } else {
    fail(`streamingBuffersBytes = ${sb} bytes > 1 MiB ceiling at idle`);
  }

  // ── Assertion 3: sum-equals-total still holds ─────────────────────────
  const components = [
    'supervisorBaselineBytes',
    'vfsLruBytes',
    'vfsInFlightBytes',
    'resolverInFlightBytes',
    'preBundleSliceBytes',
    'esbuildResidentBytes',
    'streamingBuffersBytes',
  ];
  let sum = 0;
  for (const k of components) {
    const v = d.heap.breakdown[k];
    if (typeof v !== 'number') {
      fail(`breakdown.${k} = ${JSON.stringify(v)} (expected number)`);
      continue;
    }
    sum += v;
  }
  if (sum === d.heap.estimatedBytes) {
    pass(`breakdown components sum (${sum}) equals estimatedBytes`);
  } else {
    fail(`breakdown sum ${sum} != estimatedBytes ${d.heap.estimatedBytes} — accounting bug after A'.2`);
  }

  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
