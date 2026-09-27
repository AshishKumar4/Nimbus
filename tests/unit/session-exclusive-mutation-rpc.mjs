#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

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
    const rpc = new SupervisorRPC({ props: { doId: 'session', pid: process.pid } }, {
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

{
  await assert.rejects(
    rpcDestroy({
      ensureSqliteFs() {},
      sqliteFs: { hasExclusiveMutation: () => true },
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
        hasExclusiveMutation: () => false,
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
      hasExclusiveMutation: () => false,
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

console.log('session exclusive mutation RPC: ok');
