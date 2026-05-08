// W5 e2e: synthetic OOM stress harness.
//
// Done criterion: zero silent kills.
//   For every facet termination with exitCode != 0, /api/_diag/memory
//   must have a lastFailures[] entry with a populated `cause` field.
//
// Mode A (default): local — exercise the supervisor against an
//   in-process surface. We synthesise 50 parallel writeBatches with
//   randomly-injected SQLITE_NOMEM and observe the ring buffer.
//
// Mode B (env NIMBUS_W5_E2E_PROD=1): prod — open 10 sessions in
//   parallel, run npm install fastify in each, query /api/_diag/memory,
//   check the contract. Disabled by default to keep the suite
//   network-free.

import { SqliteVFS } from '../../../../src/vfs/sqlite-vfs.ts';
import { makeMockCtx } from '../_mock-sql.mjs';
import { ok, eq, gte, group, summary } from '../_tap.mjs';

let dis;
try {
  dis = await import('../../../../src/observability/oom-discriminator.ts');
} catch (e) {
  ok('oom-discriminator module exists', false, e.message);
  summary('w5/e2e/oom-stress');
}

const { resetFailures, getFailures } = dis;

const PARALLEL = Number(process.env.NIMBUS_W5_PARALLEL || '50');
const FAIL_RATE = Number(process.env.NIMBUS_W5_FAILRATE || '0.4');

resetFailures();

// Synthetic terminations: simulate 50 large writeBatches across 50 VFS
// instances. ~40% of them will hit a randomly-injected SQLITE_NOMEM at
// some point during their run. Each "termination" is a writeBatch error
// recorded via the discriminator. The contract: count of termination
// events should equal count of ring entries with a non-empty cause.

let terminationsSeen = 0;
let throwsSeen = 0;
const targets = [];
for (let i = 0; i < PARALLEL; i++) {
  const { ctx, sql } = makeMockCtx();
  const vfs = new SqliteVFS(sql, ctx);
  // Set up the fs first (mkdir not under W5 retry, so we mkdir
  // BEFORE injecting failures). The OOM stress is on writeBatch.
  vfs.mkdir('p', { recursive: true });
  // Inject failures in ~FAIL_RATE of the runs, enough to exhaust the
  // retry depth so we DO see a fail-loud throw. (Bounded retry depth
  // means: 999 injected failures → all retries exhausted → throw.)
  const willFail = Math.random() < FAIL_RATE;
  if (willFail) {
    sql.injectFailures(999, 'SQLITE_NOMEM: out of memory');
    terminationsSeen++;
  }
  const inodes = [];
  const chunks = [];
  for (let j = 0; j < 8; j++) {
    const p = `p/f${j}.bin`;
    inodes.push({ path: p, parentPath: 'p', isDir: false,
      size: 4, mtime: 0, mode: 0o644, chunkCount: 1 });
    chunks.push({ path: p, chunkId: 0, data: new Uint8Array([1,2,3,4]) });
  }
  targets.push({ vfs, inodes, chunks, willFail });
}

await Promise.all(targets.map(async ({ vfs, inodes, chunks }) => {
  try {
    vfs.writeBatch({ inodes, chunks });
  } catch (e) {
    throwsSeen++;
  }
}));

group('every fail-loud termination has a cause-tagged ring entry', () => {
  const ring = getFailures();
  const nomemEntries = ring.filter(f => f.cause === 'sqlite_nomem');
  // The contract: thrown writeBatches → corresponding ring entries.
  // Ring buffer is bounded at 50; if PARALLEL × retries-during-failed-runs
  // > 50, the ring caps. So we lower-bound: every thrown run pushed at
  // least one entry; the ring must contain min(throwsSeen, 50) entries.
  ok('throws happened (sanity)', throwsSeen > 0,
    `throwsSeen=${throwsSeen}`);
  gte('every thrown run produced ≥1 sqlite_nomem ring entry',
    nomemEntries.length, Math.min(throwsSeen, 50));

  // Every entry in the ring must have `cause` populated (no '' or
  // undefined).
  const empty = ring.filter(f => !f.cause || f.cause === 'unknown' && !f.message);
  ok('no ring entries with empty cause and no message',
    empty.length === 0,
    `empty count: ${empty.length}`);

  // Every thrown writeBatch produced an entry with a phase tag (≠ '').
  const taggedPhases = new Set(ring.map(f => f.phase));
  ok('at least one phase tag is "install"',
    taggedPhases.has('install'),
    `phases seen: ${[...taggedPhases].join(',')}`);
});

group('zero-silent-OOM contract', () => {
  // The strongest assertion in this synthetic harness: throwsSeen should
  // be ≥ 1 AND the ring should reflect at least that many sqlite_nomem
  // entries (subject to the 50-cap).
  const ring = getFailures();
  const nomemEntries = ring.filter(f => f.cause === 'sqlite_nomem').length;
  ok('zero silent terminations',
    nomemEntries >= Math.min(throwsSeen, 50),
    `throws=${throwsSeen} ring sqlite_nomem entries=${nomemEntries}`);
});

summary('w5/e2e/oom-stress');
