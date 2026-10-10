#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { asyncOnly } from './lib/async-memory-vfs.mjs';
import { SupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';

import { rpcDestroy } from '../../packages/worker/src/session/programmatic.ts';

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
} }));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
{
  const harness = createSqliteVfsTestHarness();
  try {
    const sqliteFs = new SqliteVFS(harness.sql, harness.ctx);
    const files = sqliteFs.as(CRED_KERNEL);
    files.mkdir('repo');
    files.writeFile('repo/file', 'kept until the lease ends');
    const processes = new SessionProcessSupervisor();
    const process = processes.spawn('node', [], '/', { cred: CRED_KERNEL });
    const ops = buildSessionSupervisorOps({ sqliteFs, processes, ensureSqliteFs() {} });
    const rpc = new SupervisorRPC({ props: { doId: 'session', pid: process.pid, writerId: 'exclusive-run' } }, {
      NIMBUS_SESSION: {
        idFromName: (id) => ({ toString: () => id }),
        idFromString: (id) => ({ toString: () => id }),
        get: () => ({ supervisorOp: (envelope) => ops.dispatch(envelope) }),
      },
    });
    const lease = sqliteFs.acquireExclusiveMutation('repo');
    await assert.rejects(rpc.unlink('/repo/file'), (error) => error.code === 'EBUSY');
    assert.equal(files.readFileString('repo/file'), 'kept until the lease ends');
    sqliteFs.releaseExclusiveMutation(lease.owner);
    await rpc.unlink('/repo/file');
    assert.equal(files.exists('repo/file'), false);
  } finally { harness.db.close(); }
}

// A binding minted under the lease (props.mutationOwner, as git clone's facet
// binding is) presents it on its ranged writes, truncations and renames, sent
// once or delivered exactly once; a binding without it is refused, EBUSY.
for (const delivered of [false, true]) {
  const harness = createSqliteVfsTestHarness();
  try {
    const sqliteFs = new SqliteVFS(harness.sql, harness.ctx);
    const files = sqliteFs.as(CRED_KERNEL);
    files.mkdir('repo');
    const processes = new SessionProcessSupervisor();
    const process = processes.spawn('node', [], '/', { cred: CRED_KERNEL });
    const supervisorDeliveries = delivered ? new SupervisorDeliveries() : undefined;
    const ops = buildSessionSupervisorOps({ sqliteFs, processes, supervisorDeliveries, ensureSqliteFs() {} });
    const binding = (props) => new SupervisorRPC({
      props: {
        doId: 'session',
        pid: process.pid,
        writerId: 'leased-run',
        ...(supervisorDeliveries ? { hostIncarnation: supervisorDeliveries.incarnation } : {}),
        ...props,
      },
    }, {
      NIMBUS_SESSION: {
        idFromName: (id) => ({ toString: () => id }),
        idFromString: (id) => ({ toString: () => id }),
        get: () => ({ supervisorOp: (envelope) => ops.dispatch(envelope) }),
      },
    });
    const lease = sqliteFs.acquireExclusiveMutation('repo');
    const owner = binding({ mutationOwner: lease.owner });
    const other = binding({});
    await owner.fsWriteRange('/repo/pack', 0, new TextEncoder().encode('PACK'));
    await owner.fsWriteRange('/repo/pack', 4, new TextEncoder().encode('-data'));
    assert.equal(files.readFileString('repo/pack'), 'PACK-data');
    await assert.rejects(other.fsWriteRange('/repo/pack', 9, new TextEncoder().encode('!')), (error) => error.code === 'EBUSY');
    await assert.rejects(other.fsTruncate('/repo/pack', 4), (error) => error.code === 'EBUSY');
    await assert.rejects(other.rename('/repo/pack', '/repo/named.pack'), (error) => error.code === 'EBUSY');
    assert.equal(files.readFileString('repo/pack'), 'PACK-data');
    await owner.fsTruncate('/repo/pack', 4);
    await owner.rename('/repo/pack', '/repo/named.pack');
    assert.equal(files.readFileString('repo/named.pack'), 'PACK');
    assert.equal(files.exists('repo/pack'), false);
    sqliteFs.releaseExclusiveMutation(lease.owner);
    await other.fsWriteRange('/repo/named.pack', 4, new TextEncoder().encode('!'));
    assert.equal(files.readFileString('repo/named.pack'), 'PACK!');
  } finally { harness.db.close(); }
}

{
  await assert.rejects(
    rpcDestroy({
      ensureSqliteFs() {},
      sqliteFs: { publishedFor: () => null, hasExclusiveMutation: () => true },
    }),
    /EBUSY: session has an active exclusive filesystem mutation/,
  );
}

{
  let guardActive = false;
  let releases = 0;
  const self = {
    sqliteFs: null,
    ensureSqliteFs() {
      if (this.sqliteFs) return;
      this.sqliteFs = {
        publishedFor: () => null, cancelStreams() {}, hasExclusiveMutation: () => false,
        acquireGlobalExclusiveMutation() {
          guardActive = true;
          return { root: '', owner: 'destroy-owner' };
        },
        releaseExclusiveMutation(owner) {
          assert.equal(owner, 'destroy-owner');
          guardActive = false;
          releases++;
        },
      };
    },
    processes: { getAll: () => [], flushLogs() {} },
    portRegistry: {},
    ctx: {
      getWebSockets: () => [],
      storage: {
        async deleteAll() { assert.equal(guardActive, true); },
        async deleteAlarm() {},
        async put() {},
      },
    },
  };
  const result = await rpcDestroy(self);
  assert.equal(result.ok, true);
  assert.equal(guardActive, true, 'successful destroy released its stale-VFS reservation');
  assert.equal(releases, 0);
}

{
  let guardActive = false;
  let releases = 0;
  const self = {
    ensureSqliteFs() {},
    sqliteFs: {
      publishedFor: () => null, cancelStreams() {}, hasExclusiveMutation: () => false,
      acquireGlobalExclusiveMutation() {
        guardActive = true;
        return { root: '', owner: 'destroy-owner' };
      },
      releaseExclusiveMutation() {
        guardActive = false;
        releases++;
      },
    },
    processes: { getAll: () => [], flushLogs() {} },
    portRegistry: {},
    ctx: {
      getWebSockets: () => [],
      storage: { async deleteAll() { throw new Error('injected destroy failure'); } },
    },
  };
  await assert.rejects(rpcDestroy(self), /injected destroy failure/);
  assert.equal(guardActive, false);
  assert.equal(releases, 1, 'failed destroy did not release its reservation');
}

// A commit held for a reader's recall (a launch's image, the reader not yet
// answered) holds leases at what it changed: a destroy waits for its
// publication, which the reader's trust bounds, and is not refused EBUSY.
{
  const harness = createSqliteVfsTestHarness();
  try {
    const sqliteFs = new SqliteVFS(harness.sql, harness.ctx);
    const files = new ProcessFiles(sqliteFs);
    const reader = files.bind({ pid: 7, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
    const { readLease } = reader.acquire(sqliteFs.epoch, sqliteFs.revision(), { lease: true });
    const launching = files.bind({ pid: 8, cred: CRED_KERNEL }).synchronous;
    launching.mkdir('/var/lib/nimbus/facet-images', { recursive: true, mode: 0o755 });
    launching.writeFile('/var/lib/nimbus/facet-images/a.js', 'image');
    assert.notEqual(sqliteFs.publishedFor(), null, 'nothing held for the destroy to meet');
    const self = {
      sqliteFs,
      ensureSqliteFs() {},
      processes: { getAll: () => [], flushLogs() {} },
      portRegistry: {},
      ctx: { getWebSockets: () => [], storage: { async deleteAll() {}, async deleteAlarm() {}, async put() {} } },
    };
    let settled = false;
    const destroying = rpcDestroy(self).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false, 'a destroy went ahead of a commit held for its publication');
    reader.recalled(readLease.owner, 'revoke');
    assert.equal((await destroying).ok, true, 'a destroy was refused for a commit held for its publication');
  } finally { harness.db.close(); }
}

// A wave that commits a prefix ahead of a reader's recall and never ends,
// the reader answered: the destroy cuts it, its prefix is published, and the
// destroy completes.
{
  const harness = createSqliteVfsTestHarness();
  try {
    const sqliteFs = new SqliteVFS(harness.sql, harness.ctx);
    sqliteFs.as(CRED_KERNEL).mkdir('srv');
    const files = new ProcessFiles(sqliteFs);
    const reader = files.bind({ pid: 7, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
    const { readLease } = reader.acquire(sqliteFs.epoch, sqliteFs.revision(), { lease: true });
    const encoded = new Uint8Array(await new Response(encodeWriteBatchStream({ inodes: [], chunks: [], ops: [
      { type: 'call', call: { call: 'writeFile', path: 'srv/a.txt', mode: 0o644, data: new TextEncoder().encode('prefix') } },
      { type: 'rename', from: 'srv/a.txt', to: 'srv/b.txt' },
    ] })).arrayBuffer());
    // All but its last record, the batch-end (each record a 5-byte header, then its length's bytes).
    let last = 4;
    for (let at = 4; at < encoded.length; at += 5 + new DataView(encoded.buffer, at + 1, 4).getUint32(0, true)) last = at;
    const writing = files.bind({ pid: 8, cred: CRED_KERNEL }).writeStream(new ReadableStream({
      type: 'bytes',
      start(controller) { controller.enqueue(encoded.slice(0, last)); },
    }));
    for (let i = 0; i < 200 && sqliteFs.publishedFor() === null; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.notEqual(sqliteFs.publishedFor(), null, 'the wave committed nothing ahead of the recall');
    reader.recalled(readLease.owner, 'revoke');
    const self = {
      sqliteFs,
      ensureSqliteFs() {},
      processes: { getAll: () => [], flushLogs() {} },
      portRegistry: {},
      ctx: { getWebSockets: () => [], storage: { async deleteAll() {}, async deleteAlarm() {}, async put() {} } },
    };
    const outcome = await Promise.race([rpcDestroy(self).then((result) => result.ok), new Promise((resolve) => setTimeout(() => resolve('waiting'), 2_000))]);
    assert.equal(outcome, true, 'a destroy waited on a wave that never ends');
    await writing.catch(() => {});
  } finally { harness.db.close(); }
}

// A wave whose native part commits ahead of a reader's recall and whose
// mounted part waits on a backend that never answers, the reader answered:
// the destroy's cut ends that wait, the wave ends refused, its native part is
// published, and the destroy completes.
{
  const harness = createSqliteVfsTestHarness();
  try {
    const sqliteFs = new SqliteVFS(harness.sql, harness.ctx);
    sqliteFs.as(CRED_KERNEL).mkdir('srv');
    const files = new ProcessFiles(sqliteFs);
    const hung = [];
    files.vfs.mount('/m', asyncOnly(new MemoryVFS(), {
      deep: true,
      beforeCall: (method) => (method === 'writeFile' ? new Promise(() => { hung.push(method); }) : undefined),
    }));
    const reader = files.bind({ pid: 7, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
    const { readLease } = reader.acquire(sqliteFs.epoch, sqliteFs.revision(), { lease: true });
    const write = (path, text) => ({ type: 'call', call: { call: 'writeFile', path, mode: 0o644, data: new TextEncoder().encode(text) } });
    const writing = files.bind({ pid: 8, cred: CRED_KERNEL }).writeStream(encodeWriteBatchStream({
      inodes: [], chunks: [], ops: [write('srv/a.txt', 'native'), write('m/b.txt', 'mounted')],
    }));
    for (let i = 0; i < 200 && (hung.length === 0 || sqliteFs.publishedFor() === null); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(hung, ['writeFile'], 'the mounted part never reached its backend');
    assert.notEqual(sqliteFs.publishedFor(), null, 'the native part committed nothing ahead of the recall');
    reader.recalled(readLease.owner, 'revoke');
    const self = {
      sqliteFs,
      ensureSqliteFs() {},
      processes: { getAll: () => [], flushLogs() {} },
      portRegistry: {},
      ctx: { getWebSockets: () => [], storage: { async deleteAll() {}, async deleteAlarm() {}, async put() {} } },
    };
    const outcome = await Promise.race([rpcDestroy(self).then((result) => result.ok), new Promise((resolve) => setTimeout(() => resolve('waiting'), 2_000))]);
    assert.equal(outcome, true, 'a destroy waited on a wave its mounted backend never answers');
    assert.equal((await writing).ok, false, 'a cut wave was answered as applied');
  } finally { harness.db.close(); }
}

console.log('session exclusive mutation RPC: ok');
