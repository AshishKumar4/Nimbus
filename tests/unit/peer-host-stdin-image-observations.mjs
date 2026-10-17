#!/usr/bin/env bun
// Regression: the hosting peer reads the resident's by-path boot images
// before the guest exists. Those reads use the process's filesystem authority
// but must not count as guest observations in its stop/replay journal.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { facetImageDigest, facetImagePath } from '../../packages/fabric/src/process-fabric.ts';
import { ReplaySessions } from '../../packages/worker/src/runtime/replay-session.ts';
import { createFacetWorld, createProcessHost, PROCESS_HOST_MODES } from './lib/facet-host-harness.mjs';

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } }));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
let activeEnv;
adoptCtxExports({ SupervisorRPC: (options) => new SupervisorRPC({ props: options.props }, activeEnv) });
const source = new TextEncoder().encode('export class NimbusProcess {}');
const imagePath = facetImagePath(await facetImageDigest(source));
const pid = 73;
const writerId = '155b1a69-6735-43ac-8e9e-fd9e6ac584c4';
const boot = {
  kind: 'code',
  code: {
    compatibilityDate: '2026-09-26', compatibilityFlags: [],
    mainModule: 'worker.js', modules: {},
    vfsTextModules: { 'worker.js': imagePath },
  },
};

for (const mode of PROCESS_HOST_MODES) {
  // The session's replay sessions (FacetManager.replay): the real boundary every supervisor call goes through; no guest ran yet.
  const replay = new ReplaySessions();
  const { journal } = replay.open(pid, () => {});
  journal.start(writerId);
  const reads = [];
  const coordinator = {
    supervisorOp(envelope) {
      const { op, args, run } = envelope;
      assert.equal(envelope.pid, pid, 'boot images retain the process filesystem authority');
      reads.push({ op, args, run });
      return replay.call(op, args, envelope.pid, run, async () => {
        if (op === 'stat') return { size: source.byteLength };
        if (op === 'fsReadRangeUncached') return source.subarray(args[1], args[1] + args[2]);
        throw new Error(`unexpected image-reader op: ${op}`);
      });
    },
  };
  const env = { NIMBUS_SESSION: { idFromName: (id) => id, idFromString: (id) => id, get: () => coordinator } };
  activeEnv = env;
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('served'); },
  }));
  const host = createProcessHost(mode, world, { readFile: () => source },
    { coordDoId: `stdin-image-${mode}` });
  const hosted = await host.open({ pid, writerId, workerKey: `stdin-image-${mode}`, boot, startArgs: {} });
  try {
    await hosted.started;
    assert.equal(world.boots.length, 1);
    assert.equal(world.boots[0].config.modules['worker.js'], new TextDecoder().decode(source));
    journal.stopped();
    assert.deepEqual(journal.observations, {},
      `${mode}: loader reads are not things the guest received before fd 0; calls ${JSON.stringify(reads)}`);
    // The same process's own read is still journaled; never fix this by
    // globally exempting stat/range reads or by giving the loader pid 0.
    journal.start(writerId);
    await journal.boundary(writerId);
    await world.boots[0].config.env.SUPERVISOR.stat('/home/user/config.json');
    journal.stopped();
    assert.deepEqual(journal.observations, { stat: 1 }, 'the guest read keeps its replay contract');
    console.log(`${mode}: loader observations excluded, guest observations retained`);
  } finally {
    await hosted.release();
    replay.close(pid);
  }
}
console.log('peer-host-stdin-image-observations: ok');
