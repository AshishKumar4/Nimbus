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
// pins both directions against the real SqliteVFS — a self-write survives
// the barrier, and a peer write to the same path still evicts.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { PROCESS_DIR, shimStoreProcess } from './lib/shim-store-process.mjs';

// The platform's timer, captured before the shims wrap setTimeout in the
// resumption barrier: a wait that must not itself be a barriered resumption.
const rawSetTimeout = globalThis.setTimeout;

const enc = new TextEncoder();
const dir = PROCESS_DIR;
// /opt: seeded by the kernel, and the user's like the rest of the tree.
const { vfs, supervisor, fs, setTimeout: shimSetTimeout, stats } = shimStoreProcess({ seed: (kernel) => kernel.mkdir('opt') });
const out = { setTimeout: shimSetTimeout };

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
  assert.equal(await supervisor.readFile(written[i]), `MINE_${i}`, 'the write reached authority');
}
const seen = await new Promise((resolve) => {
  out.setTimeout(() => resolve(written.map((p) => fs.readFileSync(p, 'utf8'))), 5);
});
for (let i = 0; i < FILES; i++) {
  assert.equal(seen[i], `MINE_${i}`, 'a sync read after the barrier serves the facet own bytes');
}
assert.equal(stats.poisons, 0, 'a seeded cursor is never poisoned');
assert.equal(stats.fills, 0, `no cell was refetched (was ${stats.fills})`);
assert.ok(stats.selfWrites >= FILES, 'the barrier recognised the writes as this facet own');

// Every mutation also reports its PARENT, and that entry is still honoured:
// the parent is deliberately left unstamped. A write stamps only the file it
// wrote, because the same revision on the directory would also vouch for a
// peer's earlier change to the directory itself (a chmod at an unacquired
// revision) that this facet has never applied. The namespace takes the
// directory's new stat from the delta; there are no bytes of a directory to
// drop, so nothing is invalidated, the files' cells least of all.
assert.equal(
  stats.invalidations, 0,
  `no cached bytes are dropped for the facet's own writes (was ${stats.invalidations})`,
);

// The other direction, and the reason a name-only rule is unsound: a peer
// writes a path this facet also wrote. That invalidation is real and must
// still land, so the next sync read serves the peer bytes.
vfs.writeFile(written[0], enc.encode('PEER'));
const afterPeer = await new Promise((resolve) => {
  out.setTimeout(() => resolve(fs.readFileSync(written[0], 'utf8')), 5);
});
assert.equal(afterPeer, 'PEER', 'a peer write to a self-written path still invalidates');
assert.equal(fs.statSync(written[0]).size, 'PEER'.length, 'and the stat follows the bytes');

// The facet writing the path again re-establishes its own stamp, so the next
// barrier is quiet once more rather than permanently poisoned by the peer.
fs.writeFileSync(written[0], 'MINE_AGAIN');
await new Promise((resolve) => setTimeout(resolve, 200));
const quiet = stats.invalidations;
const back = await new Promise((resolve) => {
  out.setTimeout(() => resolve(fs.readFileSync(written[0], 'utf8')), 5);
});
assert.equal(back, 'MINE_AGAIN');
assert.equal(stats.invalidations, quiet, 'a re-written path is self-authored again');

// A speculative repair must never unstamp the facet's own write.
//
// A sync read that the view cannot serve issues a live read to make the next
// touch answerable. That read is in flight while the program carries on, and a
// program whose config was not there writes it next — so the repair lands AFTER
// the flush, installs the same bytes over the same cell, and drops the revision
// stamp that says the cell is this facet's own. The very next barrier then
// evicts the facet's own output: measured at selfWrites 0, invalidations 1 and
// fills 2 for one written file, where the same sequence without the refused
// read costs 1, 0 and 0. Live, the sync read that followed answered ENOENT for
// a file the program had written itself two turns earlier.
{
  // Under /opt, which no ancestor in this facet manifest enumerates — so the
  // first read cannot be answered from knowledge and a repair is put in flight.
  const CFG = '/opt/tool-nodejs/config.json';
  const before = { fills: stats.fills, invalidations: stats.invalidations, self: stats.selfWrites };

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
  assert.ok(
    stats.selfWrites > before.self,
    'the barrier must recognise the write as this facet own despite the repair',
  );
  assert.equal(
    stats.invalidations, before.invalidations,
    'the newly announced parent directory is a namespace row, and no cached bytes are dropped for it',
  );
  assert.equal(
    stats.fills, before.fills,
    `and nothing was refetched that never left (was ${stats.fills - before.fills})`,
  );
}

// A peer writes a path while this facet's own write of it is still being
// acknowledged: the authority applied the write at r1 and holds the response,
// then the peer wrote the path at r2 and another path after it. The facet
// cannot tell until the response lands whether the r2 a barrier reports was
// its own write or a later one, so a resumption behind that barrier must not
// run on the parked bytes — it would read the peer's second path new and the
// first one from before the peer (lean/Nimbus/Coherence/StoreBugs.lean,
// own_committed_write_is_served_past_a_peer). The resident store served them
// (resident-store-provenance.mjs); on the heap the reported cell is evicted and
// its refetch queues behind the write, and this holds that line.
{
  const P = `${dir}/race.txt`;
  const Q = `${dir}/q.txt`;
  fs.writeFileSync(Q, 'q0');
  await new Promise((resolve) => setTimeout(resolve, 200));

  const writeFile = supervisor.writeFile;
  const gate = Promise.withResolvers();
  const applied = Promise.withResolvers();
  supervisor.writeFile = async (p, content) => {
    const revision = await writeFile(p, content);
    if (p.endsWith('/race.txt')) {
      applied.resolve();
      await gate.promise;
    }
    return revision;
  };
  fs.writeFileSync(P, 'MINE');
  await applied.promise;
  vfs.writeFile(P, enc.encode('PEER'));
  vfs.writeFile(Q, enc.encode('q1'));

  const resumed = new Promise((resolve) => {
    out.setTimeout(() => resolve([P, Q].map((p) => fs.readFileSync(p, 'utf8'))), 5);
  });
  const early = await Promise.race([resumed, new Promise((resolve) => rawSetTimeout(() => resolve('still waiting'), 150))]);
  assert.equal(early, 'still waiting', 'a resumption may not run on a parked write a peer may have overwritten');
  gate.resolve();
  assert.deepEqual(await resumed, ['PEER', 'q1'], 'the acknowledgement says the peer wrote last');
  supervisor.writeFile = writeFile;
}

console.log('node-shims-self-write-coherence: all assertions passed');
