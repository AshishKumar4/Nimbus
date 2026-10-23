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
// in any order: a barrier answered ahead of the process's own write, and an
// RPC that rejects. Each case is a process of its own over the real session.

import assert from 'node:assert/strict';
import { createAuthority, runScenarios, sleep } from './lib/resident-body.mjs';
import { shimsOnSession } from './lib/shims-on-session.mjs';

const dir = '/home/user/p';
const T = 1_600_000_000_000;
const enc = new TextEncoder();

/** A process in `dir` over a new session; `hooks` take over session calls (as shimsOnSession's overrides). */
function facet(hooks = {}) {
  const authority = createAuthority();
  authority.kfs.mkdir(dir, { recursive: true });
  return { authority, ...shimsOnSession({ authority, cwd: dir, overrides: hooks }) };
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
/** `promise`, or a failure naming `what` after a few seconds: a wave that never went out is a hang, not a wait. */
const within = (promise, what) => Promise.race([promise, sleep(5_000).then(() => { throw new Error(`timed out waiting for ${what}`); })]);

// Asserts that the barrier after an own mutation of `p` kept the bytes: the
// sync read serves `expected`, and the session holds the same.
async function survives(label, f, p, expected) {
  await barrier(f.fs);
  assert.equal(syncRead(f.fs, p), expected, `${label}: sync read after the barrier serves the mutated bytes`);
  assert.equal(await f.authority.peer.readFileString(p), expected, `${label}: the session holds the same bytes`);
}

/**
 * Holds the session's answer to the next write wave, once armed: the wave is
 * applied, and its response is held until `release`. `arm()` returns a promise
 * that settles once the held wave is in.
 */
function holdNextResponse() {
  let armed = false;
  let gate = null;
  let landed = null;
  let forward;
  const hooks = (given) => {
    forward = given;
    return {
      writeBatchStream: async (stream, fence, owner) => {
        const answer = await forward('writeBatchStream', [stream, fence, owner]);
        if (armed) { armed = false; landed.resolve(); await gate.promise; }
        return answer;
      },
    };
  };
  return {
    hooks,
    arm() {
      armed = true;
      gate = Promise.withResolvers();
      landed = Promise.withResolvers();
      return landed.promise;
    },
    release: () => gate.resolve(),
  };
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
    assert.equal(await f.authority.peer.readFileString(p), 'HELLO W', 'the truncate landed after the flushed append');
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
    assert.equal((await f.fs.promises.stat(p)).mtime.getTime(), T, 'utimes: the session carries the new mtime');
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
    assert.equal((await f.fs.promises.stat(p)).mode & 0o777, 0o755, 'chmod: the session carries the mode');
  },

  async 'a chmodSync rides the next flush of its path, and reaches the session'() {
    const f = facet();
    const p = `${dir}/chmod-sync.txt`;
    await f.fs.promises.writeFile(p, 'MODE2');
    f.fs.chmodSync(p, 0o700);
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    await survives('chmodSync ride-along', f, p, 'MODE2');
    assert.equal((await f.fs.promises.stat(p)).mode & 0o777, 0o700, 'chmodSync reached the session');
  },

  // ── 5. chown ────────────────────────────────────────────────────────────
  async 'chown survives the barrier after it, and reaches the session'() {
    const f = facet();
    const p = `${dir}/chown-async.txt`;
    await f.fs.promises.writeFile(p, 'OWNER');
    await f.fs.promises.chown(p, 1000, 1000);
    await survives('chown', f, p, 'OWNER');
    assert.equal((await f.fs.promises.stat(p)).uid, 1000, 'chown reached the session');
  },

  async 'a chownSync queues behind the pending write, and reaches the session'() {
    const f = facet();
    const p = `${dir}/chown-sync.txt`;
    f.fs.writeFileSync(p, 'OWNER2');
    f.fs.chownSync(p, 1000, 1000);
    await f.fs.promises.access(p);
    await survives('chownSync', f, p, 'OWNER2');
    assert.equal((await f.fs.promises.stat(p)).gid, 1000, 'chownSync reached the session');
  },

  // ── The other direction: a peer touched the path in between ────────────
  // The peer's change is the session's, so the process's next read of the
  // path serves the peer's bytes, with the process's own metadata applied.
  async 'utimes after a peer write: the peer bytes win, and the process\'s utimes is applied'() {
    const f = facet();
    const p = `${dir}/peer-utimes.txt`;
    await f.fs.promises.writeFile(p, 'MINE');
    await f.authority.peer.writeFile(p, 'PEER');
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    assert.equal(await timerRead(f, p), 'PEER', 'utimes after a peer write: the peer bytes win');
    assert.equal((await f.fs.promises.stat(p)).mtime.getTime(), T, 'and the process own utimes is applied on top');
  },

  async 'a ranged write after a peer write: the refetch shows both'() {
    const f = facet();
    const p = `${dir}/peer-range.txt`;
    await f.fs.promises.writeFile(p, 'MINE_MINE');
    await f.authority.peer.writeFile(p, 'PEERPEERPEER');
    const fh = await f.fs.promises.open(p, 'r+');
    await fh.write('X', 0);
    await fh.close();
    assert.equal(await f.fs.promises.readFile(p, 'utf8'), 'XEERPEERPEER', 'ranged write after a peer write: the refetch shows both');
  },

  async 'a truncate after a peer write: the refetch shows the peer bytes, cut'() {
    const f = facet();
    const p = `${dir}/peer-trunc.txt`;
    await f.fs.promises.writeFile(p, 'MINE_MINE');
    await f.authority.peer.writeFile(p, 'PEERPEERPEER');
    await f.fs.promises.truncate(p, 6);
    assert.equal(await f.fs.promises.readFile(p, 'utf8'), 'PEERPE', 'truncate after a peer write: the refetch shows both');
  },

  async 'a peer write elsewhere does not disturb the process\'s own file'() {
    const f = facet();
    const p = `${dir}/clock.txt`;
    const other = `${dir}/clock-other.txt`;
    await f.fs.promises.writeFile(p, 'MINE');
    await f.authority.peer.writeFile(other, 'ELSEWHERE');
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
  // barrier the real race delivers early. A decided write sends no wave until
  // something flushes, so each arming is followed by a flush: that is the wave
  // the hold holds. A peer's change waits for the process's read lease to be
  // recalled, which waits for this response, so a peer's write queued in the
  // gap lands once the response is released.
  async 'a ranged write survives a barrier answered before its response'() {
    const held = holdNextResponse();
    const f = facet(held.hooks);
    const p = `${dir}/race-range.txt`;
    await f.fs.promises.writeFile(p, 'HELLO WORLD');
    const fh = await f.fs.promises.open(p, 'r+');
    const landed = held.arm();
    const write = fh.write('JELLO', 0);
    await sleep(0);
    const sent = globalThis.__nimbusProcessFs.flush();
    await within(landed, 'the held wave');
    await barrierInGap(f.fs, held);
    await write;
    await sent;
    await fh.close();
    assert.equal(syncRead(f.fs, p), 'JELLO WORLD', 'race/range: the process own bytes survive a barrier answered ahead of its write');
    assert.equal(await f.authority.peer.readFileString(p), 'JELLO WORLD', 'race/range: the session holds the same bytes');
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    await survives('race/range, follow-up own mutation', f, p, 'JELLO WORLD');
  },

  async 'a whole-file write survives a barrier answered before its response'() {
    const held = holdNextResponse();
    const f = facet(held.hooks);
    const p = `${dir}/race-whole.txt`;
    await f.fs.promises.writeFile(p, 'FIRST');
    const landed = held.arm();
    const write = f.fs.promises.writeFile(p, 'SECOND');
    await sleep(0);
    const sent = globalThis.__nimbusProcessFs.flush();
    await within(landed, 'the held wave');
    await barrierInGap(f.fs, held);
    await write;
    await sent;
    assert.equal(syncRead(f.fs, p), 'SECOND', 'race/whole: the flushed bytes survive a barrier answered ahead of the write');
    assert.equal(await f.authority.peer.readFileString(p), 'SECOND', 'race/whole: the session holds them too');
    await f.fs.promises.utimes(p, new Date(T), new Date(T));
    await survives('race/whole, follow-up own mutation', f, p, 'SECOND');
  },

  async 'a peer write after a whole-file write is served, not the process\'s bytes'() {
    const held = holdNextResponse();
    const f = facet(held.hooks);
    const p = `${dir}/race-whole-peer.txt`;
    await f.fs.promises.writeFile(p, 'FIRST');
    const landed = held.arm();
    const write = f.fs.promises.writeFile(p, 'SECOND');
    await sleep(0);
    const sent = globalThis.__nimbusProcessFs.flush();
    await within(landed, 'the held wave');
    const peerWrite = f.authority.peer.writeFile(p, 'PEER');
    await barrierInGap(f.fs, held);
    await within(write, 'the write behind the held response');
    await sent;
    await within(peerWrite, 'the peer write behind the held response');
    assert.equal(await f.fs.promises.readFile(p, 'utf8'), 'PEER', 'race/whole-peer: the refetch serves the peer bytes');
  },

  async 'a peer write after a ranged write is served, and the range is not kept over it'() {
    const held = holdNextResponse();
    const f = facet(held.hooks);
    const p = `${dir}/race-peer.txt`;
    await f.fs.promises.writeFile(p, 'MINE_MINE');
    const fh = await f.fs.promises.open(p, 'r+');
    const landed = held.arm();
    const write = fh.write('X', 0);
    await sleep(0);
    const sent = globalThis.__nimbusProcessFs.flush();
    await within(landed, 'the held wave');
    const peerWrite = f.authority.peer.writeFile(p, 'PEERPEERPEER');
    await barrierInGap(f.fs, held);
    await within(write, 'the write behind the held response');
    await sent;
    await fh.close();
    await within(peerWrite, 'the peer write behind the held response');
    assert.equal(await timerRead(f, p), 'PEERPEERPEER', 'race/peer: the sync read serves the peer bytes');
    assert.equal(await f.authority.peer.readFileString(p), 'PEERPEERPEER', 'race/peer: and the session agrees');
  },
  // Where the bytes an awaited write left are: the sync view before any barrier, and after one.
  async 'a sync read serves an awaited write before any barrier'() {
    const f = facet();
    const p = `${dir}/pre-barrier.txt`;
    await f.fs.promises.writeFile(p, 'MINE');
    assert.equal(syncRead(f.fs, p), 'MINE', 'the sync view serves the bytes the awaited write left');
  },

  async 'a sync read serves an awaited write after one barrier'() {
    const f = facet();
    const p = `${dir}/post-barrier.txt`;
    await f.fs.promises.writeFile(p, 'MINE');
    await barrier(f.fs);
    assert.equal(syncRead(f.fs, p), 'MINE', 'the sync view serves the bytes the awaited write left, after a barrier');
  },

  // ── An RPC that rejects: its outcome is unknown, the caller is told ───────
  async 'a rejected ranged write is told to its caller, and a later read still works'() {
    let failing = false;
    const f = facet((forward) => ({
      writeBatchStream: async (stream, fence, owner) => {
        if (!failing) return forward('writeBatchStream', [stream, fence, owner]);
        await stream.cancel();
        throw Object.assign(new Error('EIO: authority died mid-write'), { code: 'EIO' });
      },
    }));
    const p = `${dir}/race-throw.txt`;
    await f.fs.promises.writeFile(p, 'KEEP');
    await globalThis.__nimbusProcessFs.flush();
    const fh = await f.fs.promises.open(p, 'r+');
    failing = true;
    await assert.rejects(() => fh.write('X', 0), /EIO/, 'race/throw: the caller is told');
    failing = false;
    // The next boundary reports the lost write once, caught or not (as resident-node-request-vfs-durability.mjs's
    // 'a caught failure of an awaited write surfaces at the next boundary, once' pins); the close is clean after it.
    await assert.rejects(() => globalThis.__nimbusProcessFs.flush(), /EIO/, 'race/throw: the next boundary reports the lost write, once');
    await fh.close();
    assert.equal(await f.fs.promises.readFile(p, 'utf8'), 'KEEP', 'race/throw: the async read still works');
  },
};

await runScenarios(import.meta.path, scenarios);
