#!/usr/bin/env bun
// The wave writer's contract, as a producer (a clone's facet) sees it:
// records land in the session as W7 waves within W7's bounds; a file of any
// size streams from its source without being held; each wave's receipts come
// back in order; a failed wave stops the writer and names itself.

import assert from 'node:assert/strict';

import { CHUNK_SIZE } from '../../packages/platform/src/limits.ts';
import { decodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createWaveWriter, WAVE_PATHS } from '../../packages/worker/src/git/wave-writer.ts';

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
    /git write wave 1 failed: .*ended at 40 of 100 bytes/,
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
  assert.match(error.message, /^git write wave 2 failed: writeBatchStream failed .*injected/);
  assert.equal(error.wave, 2);
  assert.equal(target.waves.length, 2, `${target.waves.length} waves sent; nothing may follow a failed one`);
  await assert.rejects(writer.file('late', 0o644, new Uint8Array(1)), /git write wave 2 failed/);
  await assert.rejects(writer.flush(), /git write wave 2 failed/);
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

console.log('git wave writer: ok');
