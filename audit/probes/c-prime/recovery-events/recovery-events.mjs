// Phase 1 C'.2 functional probe — recovery_event ring schema works.
//
// At this phase Track B' has not landed, so no real recovery events
// flow through the ring during a session. This probe asserts the
// SCHEMA + API work by:
//   1. Resetting the ring via /api/_test/recovery-event/reset.
//   2. Recording a synthetic event via /api/_test/recovery-event/record.
//   3. Reading /api/_diag/memory.recoveryEvents and asserting:
//      - the event is present, newest-first
//      - all required fields are populated correctly
//      - dataLoss is the boolean we sent (not undefined or string)
//      - the ring is bounded (record 60 events, expect ≤50)
//
// Real events from Track B' transitions land in the same ring. The
// interactive-liveness/error-recovery/ probe asserts those once
// Track B' is built.
//
// Probe runs against local wrangler dev. Requires NIMBUS_DEBUG=1 (set
// in wrangler.jsonc.dev or via env) — without it the /api/_test/* paths
// 404. For Phase 1 we assume the dev environment runs with debug on.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT = path.join(HERE, 'recovery-events.txt');
fs.writeFileSync(ARTIFACT, '');
const log = (s) => { fs.appendFileSync(ARTIFACT, s.endsWith('\n') ? s : s + '\n'); console.log(s); };

const BASE = process.env.BASE || 'http://127.0.0.1:8792';
let exitCode = 0;
const fail = (m) => { exitCode = 1; log('FAIL: ' + m); };
const pass = (m) => { log('PASS: ' + m); };

async function mintSession() {
  const r = await fetch(`${BASE}/new`, { method: 'POST', redirect: 'manual' });
  const loc = r.headers.get('location');
  if (!loc) throw new Error(`/new returned no Location (status ${r.status})`);
  const m = loc.match(/^\/s\/([^/]+)\/?$/);
  if (!m) throw new Error(`unexpected Location: ${loc}`);
  return m[1];
}

async function readEvents(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_diag/memory`);
  const d = await r.json();
  return d.recoveryEvents;
}

async function resetRing(sid) {
  const r = await fetch(`${BASE}/s/${sid}/api/_test/recovery-event/reset`, { method: 'POST' });
  if (r.status === 404) {
    throw new Error('NIMBUS_DEBUG is not set; /api/_test/* returned 404');
  }
  if (!r.ok) throw new Error(`reset failed: ${r.status}`);
  return r.json();
}

async function recordEvent(sid, payload) {
  const r = await fetch(`${BASE}/s/${sid}/api/_test/recovery-event/record`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`record failed: ${r.status}`);
  return r.json();
}

async function main() {
  log("==== C'.2 recovery-events probe ====");
  log('==== TIMESTAMP: ' + new Date().toISOString() + ' ====');
  log('BASE: ' + BASE);

  const sid = await mintSession();
  log('SID: ' + sid);

  // ── Stage 1: empty-ring baseline ───────────────────────────────────────
  // Phase 3 B'.1 made initSession record a cold→hydrated event into
  // the same ring, so a fresh session that opens a WS will have ≥ 1
  // event in the ring. The recovery_event ring is process-isolate
  // global (oom-discriminator.ts uses globalThis), so prior probes
  // in the same wrangler-dev isolate may also have populated it. We
  // reset explicitly here to assert the expected post-reset
  // behaviour rather than expect a serendipitously-empty ring.
  await resetRing(sid);
  let events = await readEvents(sid);
  if (!Array.isArray(events)) {
    fail("recoveryEvents is not an array on a fresh session");
  } else if (events.length !== 0) {
    fail(`fresh session has ${events.length} recovery events; expected 0`);
  } else {
    pass('fresh session has empty recovery-events ring');
  }

  // ── Stage 2: schema works for a single event ───────────────────────────
  await resetRing(sid);
  await recordEvent(sid, {
    fromState: 'cold',
    toState: 'hydrated',
    trigger: 'first-fetch',
    isolateGen: 1,
    dataLoss: false,
    snapshotKeysRehydrated: 7,
    notes: 'unit-style assertion for C\'.2',
  });
  events = await readEvents(sid);
  if (events.length !== 1) {
    fail(`expected 1 event after one record(); got ${events.length}`);
  } else {
    pass('ring contains 1 event after one record()');
    const e = events[0];
    if (e.fromState !== 'cold') fail(`fromState = ${JSON.stringify(e.fromState)}, expected 'cold'`);
    else pass('fromState = cold');
    if (e.toState !== 'hydrated') fail(`toState = ${JSON.stringify(e.toState)}, expected 'hydrated'`);
    else pass('toState = hydrated');
    if (e.trigger !== 'first-fetch') fail(`trigger = ${JSON.stringify(e.trigger)}, expected 'first-fetch'`);
    else pass('trigger = first-fetch');
    if (e.dataLoss !== false) fail(`dataLoss = ${JSON.stringify(e.dataLoss)}; expected boolean false (not undefined)`);
    else pass('dataLoss is boolean false');
    if (e.snapshotKeysRehydrated !== 7) fail(`snapshotKeysRehydrated = ${e.snapshotKeysRehydrated}, expected 7`);
    else pass('snapshotKeysRehydrated = 7');
    if (typeof e.at !== 'number' || e.at <= 0) fail(`at = ${e.at}, expected positive number`);
    else pass('at is a positive ms timestamp');
    if (e.notes && e.notes.includes("C'.2")) pass('notes preserved');
    else fail(`notes not preserved: ${JSON.stringify(e.notes)}`);
  }

  // ── Stage 3: newest-first ordering ─────────────────────────────────────
  await resetRing(sid);
  await recordEvent(sid, { fromState: 'cold', toState: 'hydrated', trigger: 'one' });
  await recordEvent(sid, { fromState: 'hydrated', toState: 'active', trigger: 'two' });
  await recordEvent(sid, { fromState: 'active', toState: 'drained', trigger: 'three' });
  events = await readEvents(sid);
  if (events.length !== 3) {
    fail(`expected 3 events; got ${events.length}`);
  } else {
    pass('ring contains 3 events');
    if (events[0].trigger === 'three' && events[1].trigger === 'two' && events[2].trigger === 'one') {
      pass('events are ordered newest-first');
    } else {
      fail(`events out of order: ${events.map(e => e.trigger).join(',')}; expected three,two,one`);
    }
  }

  // ── Stage 4: ring bounded at 50 ────────────────────────────────────────
  await resetRing(sid);
  for (let i = 0; i < 60; i++) {
    await recordEvent(sid, {
      fromState: 'active',
      toState: 'drained',
      trigger: `batch-${i}`,
    });
  }
  events = await readEvents(sid);
  if (events.length === 50) {
    pass(`ring bounded at 50 even after 60 records (got ${events.length})`);
  } else {
    fail(`ring not bounded: 60 records → ${events.length} events; expected 50`);
  }
  // The newest 50 should be batch-10..batch-59 (we kept the latest).
  if (events[0].trigger === 'batch-59' && events[49].trigger === 'batch-10') {
    pass('LRU-style: newest 50 retained, oldest 10 dropped');
  } else {
    fail(`bounded-ring eviction kept wrong window: head=${events[0].trigger} tail=${events[49].trigger}`);
  }

  // Cleanup
  await resetRing(sid);

  log('==== EXIT ' + exitCode + ' ====');
  process.exit(exitCode);
}

main().catch((e) => {
  log('UNCAUGHT: ' + (e?.stack || e));
  process.exit(2);
});
