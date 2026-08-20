#!/usr/bin/env bun
// Recovery must never leave a durable state in which an owed launch has no
// journal row. The platform's storage semantics (PLATFORM.md): writes buffer
// and flush in the background in order, `sync()` is the only durability
// barrier, a reset destroys every unflushed write, and a promise in flight
// when the object resets is cancelled where it stands — `ctx.waitUntil`
// retains nothing. So the durable states reachable during recovery are the
// ordered prefixes of recovery's own write sequence, cut anywhere by a reset
// that also kills the un-awaited re-drive.
//
// The defect this pins: recoverInterrupted deleted the old row FIRST and
// fired the re-drive un-awaited. A flush boundary between that delete and
// the re-driven launch's own journal write left "row gone, replacement not
// yet written"; a reset there lost the resident permanently and silently —
// after the user was told it was being restarted.

import assert from 'node:assert/strict';
import { FENCED_WORK_KEY_PREFIX, FencedWork } from '../../packages/fabric/src/fenced-work.ts';

/**
 * DO storage as the platform behaves: reads see buffered writes; flush()
 * models the background flush (in-order, any time); sync() is the barrier;
 * crash() is a reset — every unflushed write is gone.
 */
function createStorage(durable = new Map()) {
  let buffered = [];
  const view = () => {
    const m = new Map(durable);
    for (const op of buffered) {
      if (op.kind === 'put') m.set(op.key, op.value);
      else m.delete(op.key);
    }
    return m;
  };
  return {
    durable,
    async put(key, value) { buffered.push({ kind: 'put', key, value: structuredClone(value) }); },
    async delete(key) { buffered.push({ kind: 'delete', key }); return view().has(key); },
    async list({ prefix }) {
      const m = new Map();
      for (const [k, v] of view()) if (k.startsWith(prefix)) m.set(k, structuredClone(v));
      return m;
    },
    async sync() { this.flush(); },
    flush() {
      for (const op of buffered) {
        if (op.kind === 'put') durable.set(op.key, op.value);
        else durable.delete(op.key);
      }
      buffered = [];
    },
    crash() { buffered = []; },
  };
}

function createHost(storage, base, { redrive } = {}) {
  const events = { redriven: [], abandoned: [], failed: [] };
  const settles = [];
  const work = new FencedWork(storage, {
    generationBase: () => base,
    waitUntil: (promise) => settles.push(promise),
    redrive: redrive ?? (async (record, attempt) => {
      events.redriven.push({ pid: record.pid, attempt });
    }),
    onAbandoned: (record) => events.abandoned.push(record.pid),
    onRedriveFailed: (record, e) => events.failed.push([record.pid, String(e)]),
  });
  return { work, events, settles };
}

const ROW = { pid: 5, command: 'node server.js', attempt: 0, phase: 'starting' };
const KEY = `${FENCED_WORK_KEY_PREFIX}5`;

// ── 1. A reset between recovery's bookkeeping and the re-drive's own journal
//      write must not lose the launch ─────────────────────────────────────────

{
  const storage = createStorage(new Map([[KEY, ROW]]));
  // The re-drive never reaches its own journal write: the reset that this
  // case models kills the instance first. waitUntil retains nothing.
  const { work, events } = createHost(storage, 10, { redrive: () => new Promise(() => {}) });
  await work.recoverInterrupted();
  assert.equal(events.redriven.length, 0, 'fixture: this re-drive hangs before journalling');

  // The background flush lands recovery's own writes; then the reset.
  storage.flush();
  storage.crash();

  // The replacement instance reads what is durable. The launch was owed and
  // its re-drive died un-journalled — the record must still be visible: either
  // re-driven again or abandoned LOUDLY, never silently absent.
  const successor = createHost(storage, 20);
  await successor.work.recoverInterrupted();
  assert.equal(
    successor.events.redriven.length + successor.events.abandoned.length, 1,
    'the interrupted re-drive is still visible to the replacement instance',
  );
  assert.deepEqual(successor.events.abandoned, [5],
    'the attempt was spent durably before the re-drive started, so the recurrence abandons');
}

// ── 2. The attempt budget bounds re-drives across any reset interleaving ────

{
  const storage = createStorage(new Map([[KEY, ROW]]));
  const first = createHost(storage, 10, { redrive: () => new Promise(() => {}) });
  await first.work.recoverInterrupted();
  storage.flush();
  storage.crash();

  const second = createHost(storage, 20, { redrive: () => new Promise(() => {}) });
  await second.work.recoverInterrupted();
  storage.flush();
  storage.crash();

  const third = createHost(storage, 30);
  await third.work.recoverInterrupted();
  assert.equal(third.events.redriven.length, 0, 'FENCED_WORK_MAX_ATTEMPT bounds the recurrence');
}

// ── 3. A settled re-drive supersedes the old row: later recoveries are clean ─

{
  const storage = createStorage(new Map([[KEY, ROW]]));
  const { work, events, settles } = createHost(storage, 10);
  await work.recoverInterrupted();
  assert.deepEqual(events.redriven, [{ pid: 5, attempt: 1 }]);
  await Promise.all(settles);
  storage.flush();

  const successor = createHost(storage, 20);
  await successor.work.recoverInterrupted();
  assert.equal(successor.events.abandoned.length, 0,
    'a settled re-drive leaves no stale row to abandon later');
  assert.equal(successor.events.redriven.length, 0);
}

// ── 4. A reset DURING recovery's own flush rolls it back; recovery repeats ──

{
  const storage = createStorage(new Map([[KEY, ROW]]));
  // The reset lands while recovery's barrier is in flight: the buffer is
  // gone and nothing after the sync ever runs. One-shot — the successor's
  // storage behaves normally.
  const behavedSync = storage.sync.bind(storage);
  storage.sync = async () => {
    storage.sync = behavedSync;
    storage.crash();
    throw new Error('instance reset during flush');
  };
  const first = createHost(storage, 10, { redrive: () => new Promise(() => {}) });
  await first.work.recoverInterrupted().catch(() => {});
  assert.equal(first.events.redriven.length, 0, 'fixture: the reset preempted the dispatch');

  const successor = createHost(storage, 20);
  await successor.work.recoverInterrupted();
  assert.deepEqual(successor.events.redriven, [{ pid: 5, attempt: 1 }],
    'a rolled-back recovery repeats on the replacement instance');
}

// ── 5. A failed re-drive reports and still supersedes its row ───────────────

{
  const storage = createStorage(new Map([[KEY, ROW]]));
  const { work, events, settles } = createHost(storage, 10, {
    redrive: async () => { throw new Error('bundle no longer parses'); },
  });
  await work.recoverInterrupted();
  await Promise.all(settles);
  assert.equal(events.failed.length, 1, 'the failure is reported');
  storage.flush();

  const successor = createHost(storage, 20);
  await successor.work.recoverInterrupted();
  assert.equal(successor.events.abandoned.length + successor.events.redriven.length, 0,
    'a reported failure is settled business, not a row to re-surface');
}

console.log('ok - fabric-fenced-work-recovery (no silent-loss window, bounded attempts, supersede)');
