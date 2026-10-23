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
// Each case is a process of its own over the real session (runScenarios).

import assert from 'node:assert/strict';
import { createAuthority, runScenarios, sleep } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const dir = '/home/user/p';
const FILES = 40;

/**
 * A process in `dir` over a new session. `hold` holds the session's answer to
 * the next write wave: `hold.next()` arms it, the wave is applied, and its
 * answer waits until `hold.release()`; `hold.applied` settles once it is in.
 */
function facet() {
  const authority = createAuthority();
  authority.kfs.mkdir(dir, { recursive: true });
  const hold = { armed: false, applied: null, gate: null };
  const { fs, setTimeout: shimSetTimeout } = shimsOnSession({
    authority,
    cwd: dir,
    overrides: (forward) => ({
      writeBatchStream: async (stream, fence, owner) => {
        const holding = hold.armed;
        hold.armed = false;
        const answer = await forward('writeBatchStream', [stream, fence, owner]);
        if (holding) { hold.applied.resolve(); await hold.gate.promise; }
        return answer;
      },
    }),
  });
  hold.next = () => {
    hold.armed = true;
    hold.applied = Promise.withResolvers();
    hold.gate = Promise.withResolvers();
    return hold.applied.promise;
  };
  hold.release = () => hold.gate.resolve();
  return {
    authority,
    fs,
    // `setTimeout` is the SHIM-wrapped one — the factory installed it on
    // globalThis — so each wait through it is itself a barriered resumption.
    out: { setTimeout: shimSetTimeout },
    hold,
    stats: () => globalThis.__nimbusProcessFs.stats(),
  };
}

/** A wait through the shim's timer: a barriered resumption, as the write-back lands inside it. */
const later = (f, ms) => new Promise((resolve) => f.out.setTimeout(resolve, ms));
/** `promise`, or a failure naming `what` after a few seconds: a wave that never went out is a hang, not a wait. */
const within = (promise, what) => Promise.race([promise, sleep(5_000).then(() => { throw new Error(`timed out waiting for ${what}`); })]);

/** The facet writes `FILES` files and waits through two barriers for the write-back. */
async function selfWritten(f) {
  const written = [];
  for (let i = 0; i < FILES; i++) {
    const p = `${dir}/f${i}.txt`;
    written.push(p);
    f.fs.writeFileSync(p, `MINE_${i}`);
  }
  // Counting across the whole sequence rather than around a single timer is
  // what keeps the ACQUIREs the waits perform inside the measurement.
  await later(f, 200);
  await later(f, 100);
  return written;
}

const scenarios = {
  async 'files the facet wrote survive the barriers after them, with no cell refetched'() {
    const f = facet();
    const written = await selfWritten(f);
    for (let i = 0; i < FILES; i++) {
      assert.equal(await f.authority.peer.readFileString(written[i]), `MINE_${i}`, 'the write reached authority');
    }
    const seen = await new Promise((resolve) => {
      f.out.setTimeout(() => resolve(written.map((p) => f.fs.readFileSync(p, 'utf8'))), 5);
    });
    for (let i = 0; i < FILES; i++) {
      assert.equal(seen[i], `MINE_${i}`, 'a sync read after the barrier serves the facet own bytes');
    }
    assert.equal(f.stats().fills, 0, `no cell was refetched (was ${f.stats().fills})`);
  },

  // The other direction, and the reason a name-only rule is unsound: a peer
  // writes a path this facet also wrote. That invalidation is real and must
  // still land, so the next sync read serves the peer bytes.
  async 'a peer write to a self-written path still invalidates'() {
    const f = facet();
    const written = await selfWritten(f);
    await f.authority.peer.writeFile(written[0], 'PEER');
    const afterPeer = await new Promise((resolve) => {
      f.out.setTimeout(() => resolve(f.fs.readFileSync(written[0], 'utf8')), 5);
    });
    assert.equal(afterPeer, 'PEER', 'a peer write to a self-written path still invalidates');
    assert.equal(f.fs.statSync(written[0]).size, 'PEER'.length, 'and the stat follows the bytes');
  },

  // The facet writing the path again re-establishes its own stamp, so the next
  // barrier is quiet once more rather than permanently poisoned by the peer.
  async 'a path the facet writes again after a peer write is self-authored again'() {
    const f = facet();
    const written = await selfWritten(f);
    await f.authority.peer.writeFile(written[0], 'PEER');
    f.fs.writeFileSync(written[0], 'MINE_AGAIN');
    await later(f, 200);
    const quiet = f.stats().fills;
    const back = await new Promise((resolve) => {
      f.out.setTimeout(() => resolve(f.fs.readFileSync(written[0], 'utf8')), 5);
    });
    assert.equal(back, 'MINE_AGAIN');
    assert.equal(f.stats().fills, quiet, 'a re-written path is self-authored again');
  },

  // A speculative repair must never unstamp the facet's own write.
  //
  // A sync read that the view cannot serve issues a live read to make the next
  // touch answerable. That read is in flight while the program carries on, and a
  // program whose config was not there writes it next — so the repair lands AFTER
  // the flush, installs the same bytes over the same cell, and drops the revision
  // stamp that says the cell is this facet's own. The very next barrier then
  // evicts the facet's own output. Live, the sync read that followed answered
  // ENOENT for a file the program had written itself two turns earlier.
  async 'a repair in flight does not unstamp the facet\'s own write'() {
    const f = facet();
    // Under /opt, which no ancestor in this facet's listing names as a directory of
    // its own — so the first read cannot be answered from knowledge.
    const CFG = '/opt/tool-nodejs/config.json';
    // The refused read, which is what puts a repair in flight for this path.
    assert.throws(() => f.fs.readFileSync(CFG, 'utf8'), (error) => error.code === 'ENOENT');
    f.fs.mkdirSync('/opt/tool-nodejs', { recursive: true });
    f.fs.writeFileSync(CFG, '{"preferences":{}}');
    assert.equal(f.fs.readFileSync(CFG, 'utf8'), '{"preferences":{}}', 'read-your-own-writes, same turn');
    const fillsBefore = f.stats().fills;
    await later(f, 200);
    const acrossBarrier = await new Promise((resolve) => {
      f.out.setTimeout(() => {
        let answer;
        try { answer = f.fs.readFileSync(CFG, 'utf8'); } catch (error) { answer = error.code; }
        resolve(answer);
      }, 5);
    });
    assert.equal(
      acrossBarrier, '{"preferences":{}}',
      'a file the program wrote itself must survive the barrier that follows',
    );
    assert.equal(
      f.stats().fills, fillsBefore,
      `and nothing was refetched that never left (was ${f.stats().fills - fillsBefore})`,
    );
  },

  // A peer writes a path while this facet's own write of it is still being
  // acknowledged: the session applied the write and holds the response, then the
  // peer wrote the path and another path after it. The peer's change waits for
  // the facet's read lease to be recalled, which waits for that response, so the
  // peer's writes land once the response is released, and the facet's next
  // resumption reads the peer's bytes, the second path new and the first one
  // from the peer too. A decided write sends no wave until something flushes, so
  // the write is flushed here: that is the wave the hold holds.
  async 'a peer write behind an unanswered write is what the next resumption reads'() {
    const f = facet();
    const P = `${dir}/race.txt`;
    const Q = `${dir}/q.txt`;
    f.fs.writeFileSync(Q, 'q0');
    await later(f, 200);

    const applied = f.hold.next();
    f.fs.writeFileSync(P, 'MINE');
    await sleep(0);
    const sent = globalThis.__nimbusProcessFs.flush();
    await within(applied, 'the held wave');
    const peerWrites = Promise.all([f.authority.peer.writeFile(P, 'PEER'), f.authority.peer.writeFile(Q, 'q1')]);
    f.hold.release();
    await within(peerWrites, 'the peer writes behind the held response');
    await sent;

    const resumed = await new Promise((resolve) => {
      f.out.setTimeout(() => resolve([P, Q].map((p) => f.fs.readFileSync(p, 'utf8'))), 5);
    });
    assert.deepEqual(resumed, ['PEER', 'q1'], 'the peer wrote last, and the resumption sees it');
  },
};

await runScenarios(import.meta.path, scenarios);
