#!/usr/bin/env bun
// The wave writer's contract, as a producer (a clone's facet) sees it:
// records land in the session as W7 waves within W7's bounds; a file of any
// size streams from its source without being held; each wave's receipts come
// back in order; a failed wave stops the writer and names itself.

import assert from 'node:assert/strict';

import { CHUNK_SIZE } from '../../packages/platform/src/limits.ts';
import { decodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createWaveWriter, WAVE_PATHS } from '../../packages/platform/src/wave-writer.ts';

function session({ failWave = null, receipts = false, latencyMs = 0 } = {}) {
  const files = new Map();
  const dirs = new Set();
  const waves = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const supervisor = {
    async writeBatchStream(stream) {
      const wave = waves.length + 1;
      const paths = [];
      waves.push(paths);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const decoded = await decodeWriteBatchStream(stream);
        let active = null;
        const published = [];
        for await (const record of decoded.records) {
          if (record.type === 'directory') { dirs.add(record.inode.path); paths.push(record.inode.path); }
          else if (record.type === 'delete') {
            for (const path of [...files.keys()]) if (path === record.path || path.startsWith(record.path + '/')) files.delete(path);
            paths.push(record.path);
          } else if (record.type === 'file-begin') active = { inode: record.inode, parts: [] };
          else if (record.type === 'file-chunk') {
            assert.ok(record.data.byteLength <= CHUNK_SIZE);
            active.parts.push(record.data.slice());
            record.retention.release();
          } else if (record.type === 'file-end') {
            files.set(active.inode.path, { inode: active.inode, bytes: Buffer.concat(active.parts) });
            paths.push(active.inode.path);
            published.push(active.inode);
            active = null;
          }
        }
        if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
        if (wave === failWave) return { ok: false, committedGroupSequence: 0, committedPathCount: 0, error: { message: 'injected' } };
        return {
          ok: true, committedGroupSequence: 1, committedPathCount: paths.length, inodes: paths.length, chunks: 0,
          ...(receipts ? {
            receipts: published.map((inode, index) => ({
              path: inode.path, ino: 1000 * wave + index, mode: inode.mode, size: inode.size,
              mtimeMs: inode.mtime, ctimeMs: inode.mtime + 1, uid: 1000, gid: 1000, dev: 7,
            })),
          } : {}),
        };
      } finally {
        inFlight--;
      }
    },
  };
  return { supervisor, files, dirs, waves, get maxInFlight() { return maxInFlight; } };
}

// ── Records into waves, within W7's bounds ─────────────────────────────
{
  const target = session({ receipts: true, latencyMs: 2 });
  const reports = [];
  const writer = createWaveWriter({
    supervisor: target.supervisor,
    root: 'home/user/repo',
    base: 'home/user/repo',
    mtimeMs: 1_700_000_000_000,
    onWave: (report) => reports.push(report),
  });
  const total = 1_000;
  for (let index = 0; index < total; index++) {
    await writer.file(`src/m${index % 13}/f${index}.js`, index % 50 === 0 ? 0o755 : 0o644,
      new TextEncoder().encode(`export const v = ${index};\n`));
  }
  await writer.symlink('link', 'src/m0/f0.js');
  await writer.directory('vendor/submodule');
  await writer.flush();
  assert.equal(target.maxInFlight, 1);
  assert.equal(target.files.get('home/user/repo/src/m3/f3.js').bytes.toString(), 'export const v = 3;\n');
  assert.equal(target.files.get('home/user/repo/src/m11/f50.js').inode.mode, 0o755);
  assert.equal(target.files.get('home/user/repo/link').inode.kind, 'symlink');
  assert.equal(target.files.get('home/user/repo/link').bytes.toString(), 'src/m0/f0.js');
  assert.ok(target.dirs.has('home/user/repo/vendor/submodule'));
  assert.ok(target.dirs.has('home/user/repo'), 'the root directory was not published');
  assert.ok(!target.dirs.has('home/user'), 'a directory above the root was published');
  for (const paths of target.waves) assert.ok(paths.length <= WAVE_PATHS, `a wave owned ${paths.length} paths`);
  // Receipts: every file once, in publication order, as the session answered.
  const receipts = reports.flatMap((report) => report.receipts);
  assert.equal(receipts.length, total + 1);
  assert.deepEqual(reports.map((report) => report.wave), reports.map((_, index) => index + 1));
  assert.equal(receipts[0].mtimeMs, 1_700_000_000_000);
  assert.equal(receipts[0].dev, 7);
  const stats = writer.stats();
  assert.equal(stats.files, total + 1);
  assert.equal(stats.waves, target.waves.length);
  assert.ok(stats.ownershipVisits <= 8 * (total + 2), `${stats.ownershipVisits} ownership probes for ${total} records`);
}

// ── A file of any size streams from its source, never held whole ──────
{
  const target = session();
  const writer = createWaveWriter({ supervisor: target.supervisor, root: 'r', base: 'r' });
  await writer.file('before.txt', 0o644, new TextEncoder().encode('before'));
  const size = 3 * CHUNK_SIZE + 12_345;
  const expected = new Uint8Array(size);
  for (let index = 0; index < size; index++) expected[index] = (index * 7 + 3) & 0xff;
  let pulled = 0;
  async function* source() {
    // Pieces that straddle chunk boundaries, as an inflater hands them out.
    for (let offset = 0; offset < size;) {
      const length = Math.min(size - offset, 9_973 + (offset % 5) * 17_011);
      pulled += length;
      yield expected.slice(offset, offset + length);
      offset += length;
    }
  }
  await writer.fileChunks('big.bin', 0o644, size, source());
  assert.equal(pulled, size);
  await writer.file('after.txt', 0o644, new TextEncoder().encode('after'));
  await writer.flush();
  assert.deepEqual(new Uint8Array(target.files.get('r/big.bin').bytes), expected);
  assert.equal(target.files.get('r/before.txt').bytes.toString(), 'before');
  assert.equal(target.files.get('r/after.txt').bytes.toString(), 'after');
  const bigWave = target.waves.find((paths) => paths.includes('r/big.bin'));
  assert.ok(!bigWave.includes('r/before.txt') && !bigWave.includes('r/after.txt'),
    'a streamed file shared its wave');

  // A source that ends short fails its wave, by number.
  const short = createWaveWriter({ supervisor: target.supervisor, root: 'r', base: 'r' });
  await assert.rejects(
    short.fileChunks('short.bin', 0o644, 100, (async function* () { yield new Uint8Array(40); })()),
    /write wave 1 failed: .*ended at 40 of 100 bytes/,
  );
}

// ── Removal and replacement within a wave ─────────────────────────────
{
  const target = session();
  const writer = createWaveWriter({ supervisor: target.supervisor, root: 'r', base: 'r' });
  await writer.file('gone.txt', 0o644, new TextEncoder().encode('x'));
  await writer.remove('gone.txt');
  await writer.file('kept.txt', 0o644, new TextEncoder().encode('one'));
  await writer.file('kept.txt', 0o644, new TextEncoder().encode('two'));
  await writer.flush();
  assert.equal(target.files.has('r/gone.txt'), false);
  assert.equal(target.files.get('r/kept.txt').bytes.toString(), 'two');
}

// ── A view sharing its buffer is copied; an owned one is taken ────────
{
  const target = session();
  const writer = createWaveWriter({ supervisor: target.supervisor, root: 'r', base: 'r' });
  const shared = new Uint8Array(16).fill(65);
  await writer.file('a', 0o644, shared.subarray(0, 4));
  await writer.file('b', 0o644, shared.subarray(4, 8));
  await writer.flush();
  assert.equal(shared.byteLength, 16, 'publishing a view detached its parent buffer');
  assert.equal(target.files.get('r/b').bytes.toString(), 'AAAA');
}

// ── A failed wave is the last one sent; everything after rejects ──────
{
  const target = session({ failWave: 2 });
  const writer = createWaveWriter({ supervisor: target.supervisor, root: 'r', base: 'r' });
  let error = null;
  try {
    for (let index = 0; index < 2_000; index++) {
      await writer.file(`d${index % 7}/f${index}`, 0o644, new TextEncoder().encode(String(index)));
    }
    await writer.flush();
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'a failed wave went unreported');
  assert.match(error.message, /^write wave 2 failed: writeBatchStream failed .*injected/);
  assert.equal(error.wave, 2);
  assert.equal(target.waves.length, 2, `${target.waves.length} waves sent; nothing may follow a failed one`);
  await assert.rejects(writer.file('late', 0o644, new Uint8Array(1)), /write wave 2 failed/);
  await assert.rejects(writer.flush(), /write wave 2 failed/);
  assert.equal(target.waves.length, 2);
}

// ── No wave starts past the deadline ──────────────────────────────────
{
  const target = session();
  const writer = createWaveWriter({ supervisor: target.supervisor, root: 'r', base: 'r', deadline: Date.now() - 1 });
  await writer.file('x', 0o644, new Uint8Array(1));
  await assert.rejects(writer.flush(), /phase deadline reached before starting a new write wave/);
  assert.equal(target.waves.length, 0);
}



// ── Lost transport: a wave is sent again; an answered one never is ─────
const quick = { backoffMs: [1, 1, 1], stallMs: 200, answerDeadlineMs: 200 };
const payloadOf = (index) => new TextEncoder().encode(`record ${index}\n`.padEnd(20_000, '.'));

/** A session whose first `losses` calls fail as `loss` does, after reading part of the stream. */
function lossy(loss, losses = 1) {
  const target = session();
  let calls = 0;
  const abandoned = [];
  const supervisor = {
    async writeBatchStream(stream) {
      calls++;
      if (calls <= losses) {
        const reader = stream.getReader();
        await reader.read();
        if (loss === 'unanswered') {
          // Stuck past the deadline, then reads on: the writer has errored its stream.
          abandoned.push(new Promise((resolve) => setTimeout(resolve, 3 * quick.stallMs))
            .then(() => reader.read())
            .then((next) => (next.done ? 'ended' : 'read'), (error) => `errored: ${error?.message ?? error}`));
          return new Promise(() => {});
        }
        throw loss;
      }
      return target.supervisor.writeBatchStream(stream);
    },
  };
  return { target, supervisor, get calls() { return calls; }, abandoned };
}

{
  const lost = lossy(new Error('Network connection lost.'));
  const writer = createWaveWriter({ supervisor: lost.supervisor, root: 'r', base: 'r', retry: quick });
  for (let index = 0; index < 50; index++) await writer.file(`f${index}`, 0o644, payloadOf(index));
  await writer.flush();
  assert.equal(lost.calls, 2, 'a wave whose connection was lost was not sent again');
  assert.equal(writer.stats().retries, 1);
  for (let index = 0; index < 50; index++) assert.deepEqual(new Uint8Array(lost.target.files.get(`r/f${index}`).bytes), payloadOf(index));
}

{
  const lost = lossy('unanswered');
  const writer = createWaveWriter({ supervisor: lost.supervisor, root: 'r', base: 'r', retry: quick });
  for (let index = 0; index < 50; index++) await writer.file(`f${index}`, 0o644, payloadOf(index));
  await writer.flush();
  assert.equal(lost.calls, 2, 'an unanswered wave was not sent again');
  assert.match(await lost.abandoned[0], /^errored: writeBatchStream (unanswered|stalled)/,
    'the abandoned attempt could still read its stream');
  assert.deepEqual(new Uint8Array(lost.target.files.get('r/f49').bytes), payloadOf(49));
}

{
  // The session's verdict is final.
  let calls = 0;
  const supervisor = {
    async writeBatchStream(stream) {
      calls++;
      await new Response(stream).arrayBuffer();
      return { ok: false, committedGroupSequence: 0, committedPathCount: 0, error: { message: 'EACCES' } };
    },
  };
  const writer = createWaveWriter({ supervisor, root: 'r', base: 'r', retry: quick });
  await writer.file('x', 0o644, payloadOf(1));
  await assert.rejects(writer.flush(), /write wave 1 failed: .*EACCES/);
  assert.equal(calls, 1, 'a wave the session answered was sent again');
}

{
  // A shed wave never ran: it is sent again, within a bounded budget.
  const shed = lossy(Object.assign(new Error('Durable Object is overloaded.'), { overloaded: true }), 10);
  const writer = createWaveWriter({ supervisor: shed.supervisor, root: 'r', base: 'r', retry: quick });
  await writer.file('x', 0o644, payloadOf(1));
  await assert.rejects(writer.flush(), /write wave 1 failed: Durable Object is overloaded/);
  assert.equal(shed.calls, quick.backoffMs.length + 1, `a persistently shed wave took ${shed.calls} attempts`);
}

// ── Fault domains: a refused wave fails the owners it carried ─────────
{
  const target = session();
  let calls = 0;
  const supervisor = {
    async writeBatchStream(stream) {
      calls++;
      if (calls === 1) {
        await new Response(stream).arrayBuffer();
        return { ok: false, committedGroupSequence: 0, committedPathCount: 0, error: { message: 'EACCES' } };
      }
      return target.supervisor.writeBatchStream(stream);
    },
  };
  const writer = createWaveWriter({ supervisor, root: 'r', base: 'r', retry: quick, failPerOwner: true });
  // Owner 'a' fills the first wave and spills into the second; 'b' follows.
  for (let index = 0; index < WAVE_PATHS + 50; index++) await writer.file(`a/f${index}`, 0o644, payloadOf(index), 'a').catch(() => {});
  await assert.rejects(writer.file('a/late', 0o644, payloadOf(0), 'a'), /write wave 1 failed: .*EACCES/);
  await writer.file('b/f0', 0o644, payloadOf(0), 'b');
  await writer.flush();
  assert.match(writer.failureOf('a')?.message ?? '', /write wave 1 failed/);
  assert.equal(writer.failureOf('b'), undefined);
  assert.ok(target.files.has('r/b/f0'), "an unrelated owner's record was not published");
  assert.ok(![...target.files.keys()].some((path) => path.startsWith('r/a/')),
    "a failed owner's later records were published");
}

{
  // A wave carrying a streamed source cannot be sent again: its source is spent.
  const lost = lossy(new Error('Network connection lost.'));
  const writer = createWaveWriter({ supervisor: lost.supervisor, root: 'r', base: 'r', retry: quick });
  const size = 2 * CHUNK_SIZE;
  await assert.rejects(
    writer.fileChunks('big', 0o644, size, (async function* () { yield new Uint8Array(size); })()),
    /write wave 1 failed: Network connection lost/,
  );
  assert.equal(lost.calls, 1);
}

// A call that never reached the session: the transport read a window of
// the stream (~1 MiB live) and nothing more, and no answer came. It is sent
// again once nothing has read it for stallMs, not after a long answer
// deadline. Red before: the writer waited its 60 s answer deadline (live:
// a 4 s clone batch took 63 s).
{
  const target = session();
  let calls = 0;
  const supervisor = {
    async writeBatchStream(stream) {
      calls++;
      if (calls === 1) {
        const reader = stream.getReader();
        let taken = 0;
        while (taken < 1_000_000) {
          const next = await reader.read();
          if (next.done) break;
          taken += next.value.byteLength;
        }
        return new Promise(() => {});
      }
      return target.supervisor.writeBatchStream(stream);
    },
  };
  const policy = { backoffMs: [1, 1], stallMs: 300, answerDeadlineMs: 60_000 };
  const resends = [];
  const writer = createWaveWriter({ supervisor, root: 'r', base: 'r', retry: policy, onResend: (resend) => resends.push(resend) });
  for (let index = 0; index < 200; index++) await writer.file(`f${index}`, 0o644, payloadOf(index));
  const started = Date.now();
  await writer.flush();
  const waited = Date.now() - started;
  assert.equal(calls, 2);
  assert.ok(waited < 10 * policy.stallMs, `a wave nothing read was re-sent only after ${waited} ms`);
  assert.equal(resends.length, 1);
  assert.match(resends[0]['do_call.lost_reason'], /stalled: nothing read it for 300 ms/);
  assert.deepEqual(new Uint8Array(target.files.get('r/f199').bytes), payloadOf(199));
}

// An abandoned attempt commits nothing after its re-send: the writer errors
// its stream, so a receiver that only gets to it late reads no record of it.
// Same path, different bytes in a later wave: the later bytes stay.
{
  const { SqliteVFS } = await import('../../packages/core/src/vfs/sqlite-vfs.ts');
  const { CRED_KERNEL } = await import('../../packages/core/src/runtime/os-contracts.ts');
  const { createSqliteVfsTestHarness } = await import('./sqlite-vfs-test-harness.mjs');
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  let calls = 0;
  let zombie = null;
  const supervisor = {
    writeBatchStream(stream) {
      calls++;
      if (calls === 1) {
        // Delivered only after the writer gave up on it and moved on.
        zombie = new Promise((resolve) => setTimeout(resolve, 3 * quick.stallMs))
          .then(() => vfs.writeStream(stream));
        return new Promise(() => {});
      }
      return vfs.writeStream(stream);
    },
  };
  const writer = createWaveWriter({ supervisor, root: 'z', base: 'z', retry: quick });
  await writer.file('p', 0o644, new TextEncoder().encode('first'));
  await writer.flush();
  await writer.file('p', 0o644, new TextEncoder().encode('second'));
  await writer.flush();
  assert.equal(vfs.readFileString('z/p'), 'second');
  const late = await zombie;
  assert.equal(late.ok, false, 'the abandoned attempt published after its re-send');
  assert.equal(vfs.readFileString('z/p'), 'second', "the abandoned attempt's bytes replaced a later wave's");
}

// ── Concurrent writers: admission holds the bounds ─────────────────────
{
  const target = session();
  const writer = createWaveWriter({ supervisor: target.supervisor, root: 'r', base: 'r' });
  await Promise.all(Array.from({ length: 6 }, async (_, owner) => {
    for (let index = 0; index < 700; index++) {
      await writer.file(`o${owner}/d${index % 9}/f${index}`, 0o644, new Uint8Array(3_000 + (index % 7) * 1_000));
    }
  }));
  await writer.flush();
  const stats = writer.stats();
  assert.equal(stats.files, 6 * 700);
  for (const paths of target.waves) assert.ok(paths.length <= WAVE_PATHS, `a wave owned ${paths.length} paths`);
  assert.ok(stats.maxWaveBytes <= 4 * 1024 * 1024, `a wave carried ${stats.maxWaveBytes} bytes`);
}

// ── Long paths: a wave closes on owned path bytes, not count alone ─────
{
  const target = session();
  const writer = createWaveWriter({ supervisor: target.supervisor, root: 'r', base: 'r' });
  const long = 'x'.repeat(280);
  for (let index = 0; index < 1_016; index++) await writer.file(`${long}-${index}`, 0o755, payloadOf(index));
  await writer.flush();
  assert.equal(writer.stats().files, 1_016);
  assert.ok(target.waves.length >= 2, 'a thousand 300-byte paths were sent as one wave');
}

console.log('wave writer: ok');
