#!/usr/bin/env bun
// SupervisorRPC loads the npm cache client at its first use (ask 56). When
// that load fails, a run's cache read still answers its ticket: the session
// records the read as failed, as it does any other failure of it, instead of
// keeping it pending until the run ends. For both reads that take a ticket,
// getCachedTarball and getPackument, each in a process of its own: a module
// that failed to load stays failed for the process.

import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { runScenarios } from './lib/resident-body.mjs';

/** A run's `read` (made by `call`) through SupervisorRPC, its npm cache client failing to load. */
async function failedLoad(read, call) {
  mock.module('cloudflare:workers', () => ({
    WorkerEntrypoint: class {
      constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    },
  }));
  mock.module('../../packages/worker/src/npm/r2-cache.ts', () => { throw new Error('the npm cache client failed to load'); });
  const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
  const ops = [];
  const env = { NIMBUS_SESSION: {
    idFromName: (id) => id,
    idFromString: (id) => id,
    get: () => ({
      async supervisorOp(envelope) {
        ops.push(envelope);
        // The run's read is journalled: the session hands it a ticket to answer.
        return envelope.op === read ? { ticket: `ticket-${read}`, readOnly: true } : null;
      },
      [Symbol.dispose]() {},
    }),
  } };
  const rpc = new SupervisorRPC({ props: { doId: 'session', pid: 7, writerId: 'cache-read' } }, env);
  await assert.rejects(call(rpc), /the npm cache client failed to load/, `${read}: the caller is told the load failed`);
  const answered = ops.filter((envelope) => envelope.op === 'cacheResult');
  assert.equal(answered.length, 1, `${read}: the ticket is answered once`);
  assert.equal(answered[0].args[0], `ticket-${read}`);
  assert.equal(answered[0].args[1].failed, true, `${read}: as a failed read`);
}

await runScenarios(import.meta.path, {
  getCachedTarball: () => failedLoad('getCachedTarball', (rpc) => rpc.getCachedTarball(`sha512-${'A'.repeat(86)}==`)),
  getPackument: () => failedLoad('getPackument', (rpc) => rpc.getPackument('left-pad')),
});
console.log('supervisor-npm-cache-load-failure: a cache read whose module fails to load answers its ticket');
