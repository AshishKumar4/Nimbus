#!/usr/bin/env bun
// A write wave re-sent after its call was lost never double-applies when
// the original arrives late.
//
// The platform sometimes never delivers a call to the session (lost-call.ts).
// The wave writer re-sends a wave nothing read, re-encoded, under a newer
// fence (writer, wave, attempt), and the session refuses an attempt older
// than one it has admitted from the same writer. The interleaving this pins
// is the dangerous one: the original was delayed past its re-send, and past
// a later wave that rewrote the same path, and then it lands, with every
// byte of it in hand (the transport took it all before the writer gave up).
// It must apply nothing.
//
// Real code on both sides: the wave writer, SupervisorRPC, the session's
// supervisor-op handler with its delivery store, ProcessFiles and SqliteVFS
// over SQLite. Only the platform's stub is simulated.
//
// Red before the fence: the late original applied, and put back "first".

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSupervisorBridgeStore } from '../../packages/core/src/workspace/supervisor-op.ts';
import {
  SupervisorDeliveries,
  openSupervisorDeliveries,
  supervisorDeliveryProps,
} from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createWaveWriter } from '../../packages/platform/src/wave-writer.ts';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './lib/session-supervisor-ops.mjs';

mock.module('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  },
}));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');

const enc = new TextEncoder();
const dec = new TextDecoder();
const quick = { backoffMs: [1, 1, 1], stallMs: 200, answerDeadlineMs: 200 };
const byteStream = (bytes) => new ReadableStream({
  type: 'bytes',
  start(controller) {
    controller.enqueue(bytes);
    controller.close();
  },
});

// ── The admission rule: deny by default ─────────────────────────────────
{
  const deliveries = new SupervisorDeliveries();
  const w = deliveries.openWaveWriter(7, 60_000);
  const first = deliveries.admitWave(7, w, 1, 1);
  first.check();
  const resend = deliveries.admitWave(7, w, 1, 2);
  assert.throws(() => first.check(), /ESTALE: write wave 1 attempt 1 was overtaken by wave 1 attempt 2/);
  resend.check();
  assert.throws(() => deliveries.admitWave(7, w, 1, 1), /ESTALE/, 'an overtaken attempt was admitted again');
  const next = deliveries.admitWave(7, w, 2, 1);
  assert.throws(() => resend.check(), /ESTALE/, 'an attempt of an earlier wave still commits');
  next.check();

  // Any writer the session did not open is refused, whatever it claims.
  assert.throws(() => deliveries.admitWave(7, 'made-up', 1, 1), /ESTALE: .*does not hold open/);
  // An epoch is the opening process's alone.
  assert.throws(() => deliveries.admitWave(8, w, 3, 1), /ESTALE: .*does not hold open/);
  // An epoch closes with its process.
  deliveries.forget(7);
  assert.throws(() => next.check(), /ESTALE: .*does not hold open/);
  assert.throws(() => deliveries.admitWave(7, w, 3, 1), /ESTALE: .*does not hold open/);
  console.log('  ok  an attempt is admitted only under an open epoch, and only if no newer one was');
}

// ── An attempt that lands after its epoch expired is refused ────────────
{
  const deliveries = new SupervisorDeliveries();
  const w = deliveries.openWaveWriter(7, 50);
  deliveries.admitWave(7, w, 1, 1).check();
  const running = deliveries.admitWave(7, w, 2, 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  // The original of wave 3, lost and arriving after the epoch closed: no
  // newer attempt was ever admitted, so only expiry can refuse it.
  assert.throws(() => deliveries.admitWave(7, w, 3, 1), /ESTALE: .*does not hold open/,
    'an attempt that landed after its epoch expired was admitted');
  assert.throws(() => running.check(), /ESTALE: .*does not hold open/, 'an attempt outlived by its epoch still commits');
  // Expiry frees the epoch; a fresh one is a different identity.
  const again = deliveries.openWaveWriter(7, 60_000);
  assert.notEqual(again, w);
  assert.throws(() => deliveries.admitWave(7, w, 3, 1), /ESTALE/);
  console.log('  ok  an attempt landing after its epoch expired is refused, never admitted');
}

// ── The late original, end to end ───────────────────────────────────────
{
  const harness = createSqliteVfsTestHarness();
  const kernel = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', 1000, 1000);
  const ctx = {};
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const processes = new SessionProcessSupervisor();
  const host = { sqliteFs: vfs, processes, ensureSqliteFs() {}, supervisorDeliveries: openSupervisorDeliveries(ctx) };
  attachSupervisorOps(host, buildSessionSupervisorOps(host, createSupervisorBridgeStore({ vfs, processes, filesystem: new ProcessFiles(vfs) })));

  // The platform: the first writeBatchStream is held; the transport takes
  // its whole stream at once, and the call reaches the session only when
  // the test lets it.
  let held = null;
  let waves = 0;
  const env = {
    NIMBUS_SESSION: {
      idFromName: (id) => ({ toString: () => id }),
      idFromString: (id) => ({ toString: () => id }),
      get() {
        return {
          async supervisorOp(sent) {
            if (sent.op === 'writeBatchStream' && ++waves === 1) {
              const bytes = new Uint8Array(await new Response(sent.stream).arrayBuffer());
              let release;
              const landed = new Promise((resolve) => { release = resolve; })
                .then(() => host.supervisorOp({ ...sent, stream: byteStream(bytes) }));
              held = { release, landed };
              return landed;
            }
            return host.supervisorOp(sent);
          },
        };
      },
    },
  };
  const pid = processes.spawn('git', ['git'], '/home/user').pid;
  const rpc = new SupervisorRPC({ props: { doId: 'session', pid, writerId: 'fence-run', ...supervisorDeliveryProps(ctx) } }, env);
  const writer = createWaveWriter({
    supervisor: {
      writeBatchStream: (stream, fence) => rpc.writeBatchStream(stream, fence),
      openWaveWriter: () => rpc.openWaveWriter(),
    },
    root: 'home/user/repo',
    base: 'home/user/repo',
    retry: quick,
  });
  await writer.file('p', 0o644, enc.encode('first'));
  await writer.flush();
  assert.equal(writer.stats().retries, 1, 'the held wave was not re-sent');
  await writer.file('p', 0o644, enc.encode('second'));
  await writer.flush();
  const user = vfs.as(CRED_KERNEL);
  assert.equal(dec.decode(user.readFile('home/user/repo/p')), 'second');

  // Now the original lands, whole.
  held.release();
  const late = await held.landed.then((answer) => answer, (error) => ({ thrown: error }));
  assert.equal(dec.decode(user.readFile('home/user/repo/p')), 'second',
    "the late original applied over its re-send and the later wave's write");
  assert.match(late.thrown?.message ?? late.error?.message ?? '', /ESTALE/, 'the late original was not refused as stale');
  console.log('  ok  an original that lands after its re-send and a later wave applies nothing');
}

// ── Overtaken while it runs: the next commit is refused ─────────────────
{
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  vfs.mkdir('t', { recursive: true });
  // Three groups' worth of 300 KB files (a group holds up to 1 MiB).
  const inodes = [];
  const chunks = [];
  for (let index = 0; index < 9; index++) {
    const data = new Uint8Array(300_000).fill(index + 1);
    const path = `t/f${index}`;
    const chunkCount = Math.ceil(data.byteLength / 65_536);
    inodes.push({ path, parentPath: 't', kind: 'file', isDir: false, size: data.byteLength, mtime: 1, mode: 0o644, chunkCount });
    for (let chunkId = 0; chunkId < chunkCount; chunkId++) chunks.push({ path, chunkId, data: data.slice(chunkId * 65_536, (chunkId + 1) * 65_536) });
  }
  let admitted = 0;
  const result = await vfs.writeStream(encodeWriteBatchStream({ inodes, chunks }), {
    admit() {
      admitted++;
      if (admitted > 1) throw Object.assign(new Error('ESTALE: overtaken'), { code: 'ESTALE' });
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /ESTALE: overtaken/);
  const written = inodes.filter((inode) => vfs.exists(inode.path)).length;
  assert.ok(written > 0 && written < inodes.length, `${written} of ${inodes.length} files: the first group should commit and no later one`);
  assert.equal(result.committedPathCount, written);
  console.log(`  ok  an attempt overtaken while it runs commits nothing more (${written} of ${inodes.length} files)`);
}

// ── A process's first epoch is the one minted with its binding: no round trip ──
{
  const harness = createSqliteVfsTestHarness();
  const kernel = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', 1000, 1000);
  const ctx = {};
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const processes = new SessionProcessSupervisor();
  const host = { sqliteFs: vfs, processes, ensureSqliteFs() {}, supervisorDeliveries: openSupervisorDeliveries(ctx) };
  attachSupervisorOps(host, buildSessionSupervisorOps(host, createSupervisorBridgeStore({ vfs, processes, filesystem: new ProcessFiles(vfs) })));
  const ops = [];
  const env = {
    NIMBUS_SESSION: {
      idFromName: (id) => ({ toString: () => id }),
      idFromString: (id) => ({ toString: () => id }),
      get: () => ({ supervisorOp: (sent) => { ops.push(sent.op); return host.supervisorOp(sent); } }),
    },
  };
  const pid = processes.spawn('node', ['node'], '/home/user').pid;
  const props = { doId: 'session', pid, writerId: 'minted-run', ...supervisorDeliveryProps(ctx, pid) };
  assert.equal(typeof props.waveWriter, 'string', 'no epoch was minted with the binding');
  const rpc = new SupervisorRPC({ props }, env);
  assert.equal(await rpc.openWaveWriter(true), props.waveWriter);
  assert.deepEqual(ops, [], 'the first epoch cost a round trip');
  // Admitted: a wave fenced with it lands.
  const fence = { writer: props.waveWriter, wave: 1, attempt: 1 };
  const landed = await rpc.writeBatchStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops: [{ type: 'call', call: { call: 'writeFile', path: 'home/user/minted', mode: 0o644, data: enc.encode('m') } }] }), fence);
  assert.equal(landed.ok, true, JSON.stringify(landed.error));
  // Any later epoch is a new one: a writer that numbers afresh never reuses one.
  const later = await rpc.openWaveWriter(false);
  assert.notEqual(later, props.waveWriter);
  assert.deepEqual(ops, ['writeBatchStream', 'openWaveWriter']);
  // An old binding's epoch is not handed out.
  const stale = new SupervisorRPC({ props: { ...props, waveWriterMintedAt: Date.now() - 10 * 60_000 } }, env);
  assert.notEqual(await stale.openWaveWriter(true), props.waveWriter);
  console.log('  ok  a process\'s first epoch is its binding\'s, and only the first');
}

console.log('wave writer fence: ok');
