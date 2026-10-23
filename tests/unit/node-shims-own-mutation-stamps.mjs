#!/usr/bin/env bun
// A process's own mutation of a file it holds — a ranged FileHandle write,
// truncate, utimes, chmod, chown — is the process's, not a peer's, when the
// next barrier reports it. Without that, the barrier reads the process's own
// change as a peer's, drops the bytes it holds, and a synchronous read that
// follows refuses (EAGAIN) on bytes the process just wrote. Live, that was
// modern-tar's open → write → futimes → close followed by a sync read of the
// extracted README, which exits create-astro with 1.
//
// The session holds what the process decided and reports it at its barrier,
// in any order: a barrier answered ahead of the process's own write, a peer's
// write landing between the process's write and its acknowledgement, and an
// RPC that rejects. Each case is pinned here on the real session, the process's
// reads answered as a program's are.

import assert from 'node:assert/strict';
import { createAuthority, runScenarios, sleep } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const dir = '/home/user/p';
const T = 1_600_000_000_000;
const enc = new TextEncoder();

/**
 * A process in `dir` over a new session. `hooks` are the session calls it
 * takes over (`overrides`, as shimsOnSession has them); `seed` makes what the
 * session holds before the process starts.
 */
function facet({ hooks = {}, seed = () => {} } = {}) {
  const authority = createAuthority();
  authority.kfs.mkdir(dir, { recursive: true });
  seed(authority);
  const shims = shimsOnSession({ authority, cwd: dir, overrides: hooks });
  return { authority, ...shims };
}

/** A barrier: an async stat of the directory, the cheapest one a process takes. */
const barrier = (fs) => fs.promises.stat(dir);
/** A shim timer's barrier, then a synchronous read of `p` in its callback. */
const timerRead = (f, p) => new Promise((resolve, reject) => {
  f.setTimeout(() => { try { resolve(f.fs.readFileSync(p, 'utf8')); } catch (error) { reject(error); } }, 5);
});
const syncRead = (fs, p) => {
  try { return fs.readFileSync(p, 'utf8'); } catch (error) { return `${error.code}: ${error.message}`; }
};

// Asserts that the barrier after an own mutation of `p` kept the bytes: the
// sync read serves `expected`, and the authority holds the same.
async function survives(label, f, p, expected) {
  await barrier(f.fs);
  assert.equal(syncRead(f.fs, p), expected, `${label}: sync read after the barrier serves the mutated bytes`);
  assert.equal(f.authority.kfs.readFileString(p), expected, `${label}: the authority holds the same bytes`);
}

/**
 * Holds the session's answer to the next write wave: the wave is applied, and
 * its response is held until `release`. `arrived` settles once the wave is in.
 */
function holdNextResponse() {
  const gate = Promise.withResolvers();
  const arrived = Promise.withResolvers();
  let forward;
  let holding = true;
  const hooks = (given) => {
    forward = given;
    return {
      writeBatchStream: async (stream, fence, owner) => {
        const answer = await forward('writeBatchStream', [stream, fence, owner]);
        if (holding) { holding = false; arrived.resolve(); await gate.promise; }
        return answer;
      },
    };
  };
  return { hooks, arrived: arrived.promise, release: () => gate.resolve() };
}

/** A barrier taken inside the gap a held response leaves open, then the response released. */
async function barrierInGap(fs, held) {
  const taken = barrier(fs);
  await sleep(20);
  held.release();
  await taken;
}

const scenarios = {
  // ── 1. Ranged write through a FileHandle ────────────────────────────────
  async 'a ranged write over a pending sync write survives the barrier after it'() {
    const f = facet();
    const p = `${dir}/range-sync.txt`;
    f.fs.writeFileSync(p, 'HELLO WORLD');
    const fh = await f.fs.promises.open(p, 'r+');
    await fh.write('JELLO', 0);
    await fh.close();
    assert.equal(syncRead(f.fs, p), 'JELLO WORLD', 'range: local overlay is immediate');
    await survives('range after sync write', f, p, 'JELLO WORLD');
  },

  async 'a ranged write after an awaited whole-file write survives the barrier after it'() {
    const f = facet();
    const p = `${dir}/range-async.txt`;
    await f.fs.promises.writeFile(p, 'HELLO WORLD');
    const fh = await f.fs.promises.open(p, 'r+');
    await fh.write(enc.encode('!!'), 0, 2, 9);
    await fh.close();
    await survives('range after async write', f, p, 'HELLO WOR!!');
  },

  async 'open with create, write, futimes and close, then a sync read, serves the bytes'() {
    const f = facet();
    const p = `${dir}/tar.txt`;
    const fh = await f.fs.promises.open(p, 'w');
    await fh.write('README');
    await fh.utimes(new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    await fh.close();
    await survives('open+write+futimes+close', f, p, 'README');
    assert.equal(f.fs.statSync(p).mtime.getTime(), 1_700_000_000_000, 'the sync stat carries the futimes');
  },

  // ── 2. Truncate ─────────────────────────────────────────────────────────
  async 'truncate of an awaited file trims the bytes the barrier keeps'() {
    const f = facet();
    const p = `${dir}/trunc-async.txt`;
    await f.fs.promises.writeFile(p, 'HELLO WORLD');
    await f.fs.promises.truncate(p, 5);
    assert.equal(syncRead(f.fs, p), 'HELLO', 'truncate: local trim is immediate');
    await survives('truncate of a flushed file', f, p, 'HELLO');
  },

  async 'ftruncate through a descriptor survives the barrier after it'() {
    const f = facet();
    const p = `${dir}/ftrunc.txt`;
    await f.fs.promises.writeFile(p, 'HELLO WORLD');
    const fh = await f.fs.promises.open(p, 'r+');
    await fh.truncate(3);
    await fh.close();
    await survives('ftruncate', f, p, 'HEL');
  },

  async 'a truncate after a pending sync append lands on the flushed file, in order'() {
    const f = facet();
    const p = `${dir}/trunc-append.txt`;
    await f.fs.promises.writeFile(p, 'HELLO');
    f.fs.appendFileSync(p, ' WORLD');
    await f.fs.promises.truncate(p, 7);
    assert.equal(f.authority.kfs.readFileString(p), 'HELLO W', 'the truncate landed after the flushed append');
    assert.equal(await f.fs.promises.readFile(p, 'utf8'), 'HELLO W');
  },

  // ── 3. utimes ───────────────────────────────────────────────────────────
  async 'utimes survives the barrier after it, and the times are the process\'s'() {
    const f = facet();
    const p = `${dir}/utimes-async.txt`;
    await f.fs.promises.writeFile(p, 'TIMES');
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    await survives('utimes', f, p, 'TIMES');
    assert.equal(f.fs.statSync(p).mtime.getTime(), T, 'utimes: the sync stat carries the new mtime');
    assert.equal((await f.fs.promises.stat(p)).mtime.getTime(), T, 'utimes: the authority carries the new mtime');
  },

  async 'utimes after a sync write flushes that write first, and survives the barrier'() {
    const f = facet();
    const p = `${dir}/utimes-sync.txt`;
    f.fs.writeFileSync(p, 'TIMES2');
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    await survives('utimes after a sync write', f, p, 'TIMES2');
  },

  // ── 4. chmod ────────────────────────────────────────────────────────────
  async 'chmod survives the barrier after it, and reaches the session'() {
    const f = facet();
    const p = `${dir}/chmod-async.txt`;
    await f.fs.promises.writeFile(p, 'MODE');
    await f.fs.promises.chmod(p, 0o755);
    await survives('chmod', f, p, 'MODE');
    assert.equal(f.fs.statSync(p).mode & 0o777, 0o755, 'chmod: the sync stat carries the mode');
    assert.equal((await f.fs.promises.stat(p)).mode & 0o777, 0o755, 'chmod: the authority carries the mode');
  },

  async 'a chmodSync rides the next flush of its path, and reaches the session'() {
    const f = facet();
    const p = `${dir}/chmod-sync.txt`;
    await f.fs.promises.writeFile(p, 'MODE2');
    f.fs.chmodSync(p, 0o700);
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    await survives('chmodSync ride-along', f, p, 'MODE2');
    assert.equal((await f.fs.promises.stat(p)).mode & 0o777, 0o700, 'chmodSync reached the authority');
  },

  // ── 5. chown ────────────────────────────────────────────────────────────
  async 'chown survives the barrier after it, and reaches the session'() {
    const f = facet();
    const p = `${dir}/chown-async.txt`;
    await f.fs.promises.writeFile(p, 'OWNER');
    await f.fs.promises.chown(p, 1000, 1000);
    await survives('chown', f, p, 'OWNER');
    assert.equal((await f.fs.promises.stat(p)).uid, 1000, 'chown reached the authority');
  },

  async 'a chownSync queues behind the pending write, and reaches the session'() {
    const f = facet();
    const p = `${dir}/chown-sync.txt`;
    f.fs.writeFileSync(p, 'OWNER2');
    f.fs.chownSync(p, 1000, 1000);
    await f.fs.promises.access(p);
    await survives('chownSync', f, p, 'OWNER2');
    assert.equal((await f.fs.promises.stat(p)).gid, 1000, 'chownSync reached the authority');
  },

  // ── The other direction: a peer touched the path in between ────────────
  // The peer's change is the session's, so the process's next read of the
  // path serves the peer's bytes, with the process's own metadata applied.
  async 'utimes after a peer write: the peer bytes win, and the process\'s utimes is applied'() {
    const f = facet();
    const p = `${dir}/peer-utimes.txt`;
    await f.fs.promises.writeFile(p, 'MINE');
    f.authority.kfs.writeFile(p, 'PEER');
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    assert.equal(await timerRead(f, p), 'PEER', 'utimes after a peer write: the cell is still evicted and the peer bytes win');
    assert.equal((await f.fs.promises.stat(p)).mtime.getTime(), T, 'and the process own utimes is applied on top');
  },

  async 'a ranged write after a peer write: the refetch shows both'() {
    const f = facet();
    const p = `${dir}/peer-range.txt`;
    await f.fs.promises.writeFile(p, 'MINE_MINE');
    f.authority.kfs.writeFile(p, 'PEERPEERPEER');
    const fh = await f.fs.promises.open(p, 'r+');
    await fh.write('X', 0);
    await fh.close();
    assert.equal(await f.fs.promises.readFile(p, 'utf8'), 'XEERPEERPEER', 'ranged write after a peer write: the refetch shows both');
  },

  async 'a truncate after a peer write: the refetch shows the peer bytes, cut'() {
    const f = facet();
    const p = `${dir}/peer-trunc.txt`;
    await f.fs.promises.writeFile(p, 'MINE_MINE');
    f.authority.kfs.writeFile(p, 'PEERPEERPEER');
    await f.fs.promises.truncate(p, 6);
    assert.equal(await f.fs.promises.readFile(p, 'utf8'), 'PEERPE', 'truncate after a peer write: the refetch shows both');
  },

  async 'a peer write elsewhere does not disturb the process\'s own file'() {
    const f = facet();
    const p = `${dir}/clock.txt`;
    const other = `${dir}/clock-other.txt`;
    await f.fs.promises.writeFile(p, 'MINE');
    f.authority.kfs.writeFile(other, 'ELSEWHERE');
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    await barrier(f.fs);
    assert.equal(syncRead(f.fs, p), 'MINE', 'a peer write elsewhere does not unstamp our cell');
  },

  // ── A barrier ANSWERED AHEAD OF THE PROCESS'S OWN WRITE ───────────────────
  //
  // The supervisor answers a barrier from memory at once, while a write's
  // response waits on the session's output gate for durability, so a barrier
  // issued after the process's own write can be answered before that write's
  // response arrives. The held response makes that ordering deterministic: the
  // session applies the wave, its answer is held, and the test takes the
  // barrier the real race delivers early.
  async 'a ranged write survives a barrier answered before its response'() {
    const held = holdNextResponse();
    const f = facet({ hooks: held.hooks });
    const p = `${dir}/race-range.txt`;
    await f.fs.promises.writeFile(p, 'HELLO WORLD');
    const fh = await f.fs.promises.open(p, 'r+');
    const write = fh.write('JELLO', 0);
    await held.arrived;
    await barrierInGap(f.fs, held);
    await write;
    await fh.close();
    assert.equal(syncRead(f.fs, p), 'JELLO WORLD', 'race/range: the process own bytes survive a barrier answered ahead of its write');
    assert.equal(f.authority.kfs.readFileString(p), 'JELLO WORLD', 'race/range: the authority holds the same bytes');
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    await survives('race/range, follow-up own mutation', f, p, 'JELLO WORLD');
  },

  async 'a whole-file write survives a barrier answered before its response'() {
    const held = holdNextResponse();
    const f = facet({ hooks: held.hooks });
    const p = `${dir}/race-whole.txt`;
    await f.fs.promises.writeFile(p, 'FIRST');
    const write = f.fs.promises.writeFile(p, 'SECOND');
    await held.arrived;
    await barrierInGap(f.fs, held);
    await write;
    assert.equal(syncRead(f.fs, p), 'SECOND', 'race/whole: the flushed bytes survive a barrier answered ahead of the write');
    assert.equal(f.authority.kfs.readFileString(p), 'SECOND', 'race/whole: the authority holds them too');
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    await survives('race/whole, follow-up own mutation', f, p, 'SECOND');
  },

  async 'a peer write after a whole-file flush is served, not the flushed bytes'() {
    const held = holdNextResponse();
    const f = facet({ hooks: held.hooks });
    const p = `${dir}/race-whole-peer.txt`;
    await f.fs.promises.writeFile(p, 'FIRST');
    const write = f.fs.promises.writeFile(p, 'SECOND');
    await held.arrived;
    f.authority.kfs.writeFile(p, 'PEER');
    await barrierInGap(f.fs, held);
    await write;
    assert.equal(await f.fs.promises.readFile(p, 'utf8'), 'PEER', 'race/whole-peer: the refetch serves the peer bytes');
  },

  async 'a peer write landing between a ranged write and its response is served'() {
    const held = holdNextResponse();
    const f = facet({ hooks: held.hooks });
    const p = `${dir}/race-peer.txt`;
    await f.fs.promises.writeFile(p, 'MINE_MINE');
    const fh = await f.fs.promises.open(p, 'r+');
    const write = fh.write('X', 0);
    await held.arrived;
    f.authority.kfs.writeFile(p, 'PEERPEERPEER');
    await barrierInGap(f.fs, held);
    await write;
    await fh.close();
    assert.equal(await timerRead(f, p), 'PEERPEERPEER', 'race/peer: the sync read serves the peer bytes');
    assert.equal(f.authority.kfs.readFileString(p), 'PEERPEERPEER', 'race/peer: and the authority agrees');
  },

  // ── An RPC that rejects: its outcome is unknown, the caller is told ───────
  async 'a rejected ranged write is told to its caller, and a later read still works'() {
    const f = facet({
      hooks: { writeBatchStream: async () => { throw Object.assign(new Error('EIO: authority died mid-write'), { code: 'EIO' }); } },
    });
    const p = `${dir}/race-throw.txt`;
    await f.fs.promises.writeFile(p, 'KEEP');
    const fh = await f.fs.promises.open(p, 'r+');
    await assert.rejects(() => fh.write('X', 0), /EIO/, 'race/throw: the caller is told');
    await fh.close();
    assert.equal(await f.fs.promises.readFile(p, 'utf8'), 'KEEP', 'race/throw: the async read still works');
  },
};

await runScenarios(import.meta.path, scenarios);
