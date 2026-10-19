#!/usr/bin/env bun
// Regression: a resident's intentional ctx.abort(NIMBUS_STOP ...) reaches
// its coordinator as an Error carrying durableObjectReset=true. The host is
// still alive; the coordinator must receive the nonce-bound stop unchanged
// so FacetManager can show its captured output and wait/replay stdin.
// Uses the real peer RPC implementation, no local workerd or bundle build.
import assert from 'node:assert/strict';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { stopRecordOf } from '../../packages/worker/src/runtime/stop-replay-host.ts';
import { createFacetWorld, createProcessHost, PROCESS_HOST_MODES } from './lib/facet-host-harness.mjs';

adoptCtxExports({ SupervisorRPC: (options) => ({ props: options.props }) });
const nonce = '324d1c69-6e5c-47c0-8a85-0b5dc9801e5c';
const record = {
  v: 3, run: 1,
  out: [{ s: 'stdout', at: 0, b: btoa('RS before 0.5\n') }],
  kind: 'stdin', until: 'end', stopAt: 0,
  tape: { seed: [1, 2, 3, 4], now: [], perf: [], random: '', reads: [], writes: [] },
};
const boot = {
  kind: 'code',
  code: { compatibilityDate: '2026-09-26', compatibilityFlags: [], mainModule: 'worker.js', modules: { 'worker.js': 'export {};' } },
};

for (const resetFlag of [false, true]) {
  for (const mode of PROCESS_HOST_MODES) {
    const error = new Error(`NIMBUS_STOP ${nonce} ${JSON.stringify(record)}`);
    if (resetFlag) error.durableObjectReset = true;
    const world = createFacetWorld(() => ({
      async startProcess() { throw error; },
      async handleHttpRequest() { return new Response('host still alive'); },
    }), { resolveConfig: false });
    const host = createProcessHost(mode, world, { readFile() { throw new Error('no disk read needed'); } },
      { coordDoId: `stdin-stop-${mode}-${resetFlag}` });
    const hosted = await host.open({
      pid: 71, writerId: crypto.randomUUID(), workerKey: `stdin-stop-${mode}-${resetFlag}`,
      boot, startArgs: { stopNonce: nonce, stdinWriter: true },
    });
    let loss = null;
    hosted.lost.catch((failure) => { loss = failure; });
    try {
      const delivered = await hosted.started.then(() => { throw new Error('a stopped boot must not succeed'); }, (failure) => failure);
      assert.deepEqual(stopRecordOf(delivered, nonce, 1), record,
        `${mode}, durableObjectReset=${resetFlag}: a boot stop must remain parseable; received ${delivered.name}: ${delivered.message}`);
      assert.equal(delivered, error, `${mode}: preserve the boot's original refusal`);
      assert.equal(loss, null, `${mode}: an intentional boot stop is not a lost hosting actor`);
      assert.equal(stopRecordOf(delivered, 'not-this-launch-00000000', 1), null, 'a different launch cannot use this stop');
      assert.equal(stopRecordOf(delivered, nonce, 2), null, 'a different run cannot use this stop');
      console.log(`${mode}, durableObjectReset=${resetFlag}: nonce-bound stdin stop preserved`);
    } finally {
      await hosted.release();
    }
  }
}
console.log('peer-host-stdin-stop: ok');
