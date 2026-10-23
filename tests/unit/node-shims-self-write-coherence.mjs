#!/usr/bin/env bun
// The invalidation log records WHAT changed, not WHO changed it, so the
// ACQUIRE barrier hands a facet back the paths it wrote itself. The facet
// then drops the cells it is holding and refetches bytes that never left —
// measured at 41 invalidations and 40 refetches for 40 written files, paid
// again at every resumption. A scaffolder or a build spends its whole run
// re-reading its own output.
//
// The repair is a revision stamp, not a "skip paths I wrote" rule: a peer
// may write the same path after us and that invalidation is real. This test
// pins both directions against the real session — a self-write survives
// the barrier (no refetch), and a peer write to the same path still evicts.

import assert from 'node:assert/strict';
import { createAuthority, sleep } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const authority = createAuthority();
const dir = '/home/user/p';
authority.kfs.mkdir(dir, { recursive: true });

// The process's session: its write waves, held when a test says so (`hold`).
let holdNext = false;
let release = null;
let applied = null;
const { fs, setTimeout: shimSetTimeout } = shimsOnSession({
  authority,
  cwd: dir,
  overrides: (forward) => ({
    writeBatchStream: async (stream, fence, owner) => {
      const hold = holdNext;
      holdNext = false;
      const answer = await forward('writeBatchStream', [stream, fence, owner]);
      // The session applied the wave and holds its answer: nothing it wrote is acknowledged yet.
      if (hold) { applied.resolve(); await release.promise; }
      return answer;
    },
  }),
});
const stats = () => globalThis.__nimbusProcessFs.stats();
const out = { setTimeout: shimSetTimeout };
const readAuthority = (p) => authority.kfs.readFileString(p);

const FILES = 40;
const written = [];
for (let i = 0; i < FILES; i++) {
  const p = `${dir}/f${i}.txt`;
  written.push(p);
  fs.writeFileSync(p, `MINE_${i}`);
}

// `setTimeout` here is the SHIM-wrapped one — the factory installed it on
// globalThis — so each of these waits is itself a barriered resumption. That
// is the point: the debounced write-back lands between them, and the ACQUIRE
// that follows is exactly the one that used to evict all 40 self-authored
// cells and refetch them. Counting across the whole sequence rather than
// around a single timer is what keeps the ACQUIREs the waits perform inside
// the measurement instead of ahead of it.
await new Promise((resolve) => setTimeout(resolve, 200));
await new Promise((resolve) => setTimeout(resolve, 100));

for (let i = 0; i < FILES; i++) {
  assert.equal(readAuthority(written[i]), `MINE_${i}`, 'the write reached authority');
}
const seen = await new Promise((resolve) => {
  out.setTimeout(() => resolve(written.map((p) => fs.readFileSync(p, 'utf8'))), 5);
});
for (let i = 0; i < FILES; i++) {
  assert.equal(seen[i], `MINE_${i}`, 'a sync read after the barrier serves the facet own bytes');
}
assert.equal(stats().fills, 0, `no cell was refetched (was ${stats().fills})`);

// The other direction, and the reason a name-only rule is unsound: a peer
// writes a path this facet also wrote. That invalidation is real and must
// still land, so the next sync read serves the peer bytes.
authority.kfs.writeFile(written[0], 'PEER');
const afterPeer = await new Promise((resolve) => {
  out.setTimeout(() => resolve(fs.readFileSync(written[0], 'utf8')), 5);
});
assert.equal(afterPeer, 'PEER', 'a peer write to a self-written path still invalidates');
assert.equal(fs.statSync(written[0]).size, 'PEER'.length, 'and the stat follows the bytes');

// The facet writing the path again re-establishes its own stamp, so the next
// barrier is quiet once more rather than permanently poisoned by the peer.
fs.writeFileSync(written[0], 'MINE_AGAIN');
await new Promise((resolve) => setTimeout(resolve, 200));
const quiet = stats().fills;
const back = await new Promise((resolve) => {
  out.setTimeout(() => resolve(fs.readFileSync(written[0], 'utf8')), 5);
});
assert.equal(back, 'MINE_AGAIN');
assert.equal(stats().fills, quiet, 'a re-written path is self-authored again');

// A speculative repair must never unstamp the facet's own write.
//
// A sync read that the view cannot serve issues a live read to make the next
// touch answerable. That read is in flight while the program carries on, and a
// program whose config was not there writes it next — so the repair lands AFTER
// the flush, installs the same bytes over the same cell, and drops the revision
// stamp that says the cell is this facet's own. The very next barrier then
// evicts the facet's own output. Live, the sync read that followed answered
// ENOENT for a file the program had written itself two turns earlier.
{
  // Under /opt, which no ancestor in this facet's listing names as a directory of
  // its own — so the first read cannot be answered from knowledge.
  const CFG = '/opt/tool-nodejs/config.json';
  const fillsBefore = stats().fills;

  // The refused read, which is what puts a repair in flight for this path.
  assert.throws(() => fs.readFileSync(CFG, 'utf8'), (error) => error.code === 'ENOENT');
  fs.mkdirSync('/opt/tool-nodejs', { recursive: true });
  fs.writeFileSync(CFG, '{"preferences":{}}');
  assert.equal(fs.readFileSync(CFG, 'utf8'), '{"preferences":{}}', 'read-your-own-writes, same turn');

  await new Promise((resolve) => setTimeout(resolve, 200));
  const acrossBarrier = await new Promise((resolve) => {
    out.setTimeout(() => {
      let answer;
      try { answer = fs.readFileSync(CFG, 'utf8'); } catch (error) { answer = error.code; }
      resolve(answer);
    }, 5);
  });
  assert.equal(
    acrossBarrier, '{"preferences":{}}',
    'a file the program wrote itself must survive the barrier that follows',
  );
  assert.equal(
    stats().fills, fillsBefore,
    `and nothing was refetched that never left (was ${stats().fills - fillsBefore})`,
  );
}

// A peer writes a path while this facet's own write of it is still being
// acknowledged: the authority applied the write at r1 and holds the response,
// then the peer wrote the path at r2 and another path after it. The facet
// cannot tell until the response lands whether the r2 a barrier reports was
// its own write or a later one, so a resumption behind that barrier must not
// run on the parked bytes — it would read the peer's second path new and the
// first one from before the peer (lean/Nimbus/Coherence/StoreBugs.lean,
// own_committed_write_is_served_past_a_peer).
{
  const P = `${dir}/race.txt`;
  const Q = `${dir}/q.txt`;
  fs.writeFileSync(Q, 'q0');
  await new Promise((resolve) => setTimeout(resolve, 200));

  release = Promise.withResolvers();
  applied = Promise.withResolvers();
  holdNext = true;
  fs.writeFileSync(P, 'MINE');
  await applied.promise;
  authority.kfs.writeFile(P, 'PEER');
  authority.kfs.writeFile(Q, 'q1');

  const resumed = new Promise((resolve) => {
    out.setTimeout(() => resolve([P, Q].map((p) => fs.readFileSync(p, 'utf8'))), 5);
  });
  const early = await Promise.race([resumed, sleep(150).then(() => 'still waiting')]);
  assert.equal(early, 'still waiting', 'a resumption may not run on a parked write a peer may have overwritten');
  release.resolve();
  assert.deepEqual(await resumed, ['PEER', 'q1'], 'the acknowledgement says the peer wrote last');
}

console.log('node-shims-self-write-coherence: all assertions passed');
