import { mock } from 'bun:test';
import { SessionProcessSupervisor } from '../../../packages/core/src/runtime/session-process-supervisor.ts';
import { ProcessFiles } from '../../../packages/core/src/runtime/process-files.ts';
import { createSupervisorBridgeStore } from '../../../packages/core/src/workspace/supervisor-op.ts';
import { openSupervisorDeliveries } from '../../../packages/core/src/workspace/supervisor-delivery.ts';
import { buildSessionSupervisorOps } from '../../../packages/worker/src/session/supervisor-op.ts';
import { attachSupervisorOps } from './session-supervisor-ops.mjs';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  },
}));
export const { SupervisorRPC } = await import('../../../packages/worker/src/session/supervisor-rpc.ts');

/** The real session supervisor assembled over a test's filesystem and processes. */
export function createRpcSession(vfs, {
  ctx = {}, processes = new SessionProcessSupervisor(), filesystem = new ProcessFiles(vfs),
} = {}) {
  const deliveries = openSupervisorDeliveries(ctx);
  const host = {
    sqliteFs: vfs, processes, supervisorDeliveries: deliveries, ensureSqliteFs() {},
    _rpcStdout: (pid, bytes) => processes.appendOutputBytes(pid, 'stdout', bytes),
  };
  const ops = buildSessionSupervisorOps(host, createSupervisorBridgeStore({ vfs, processes, filesystem }));
  attachSupervisorOps(host, ops);
  return { ctx, host, processes, deliveries, dispose: ops.dispose };
}

/** The platform namespace boundary clones both the request and its answer. */
export function supervisorRpcEnv(dispatch) {
  return {
    NIMBUS_SESSION: {
      idFromName: (id) => ({ toString: () => id }),
      idFromString: (id) => ({ toString: () => id }),
      get: () => ({
        supervisorOp: async (sent) => structuredClone(await dispatch(structuredClone(sent))),
      }),
    },
  };
}
