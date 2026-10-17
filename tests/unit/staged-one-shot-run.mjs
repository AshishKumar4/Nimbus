#!/usr/bin/env bun
// A staged one-shot (opencode): its ~23 MB module map is assembled from its
// stage in the stateless NimbusLoadedEntrypoint, on that loader's miss, never
// in the host, and its SUPERVISOR is a binding minted there, from the props
// its host handed the hop. No stub of the host's crosses the hop into the
// program: one that did (the host's capability) reset the host mid-run.

import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusLoadedEntrypoint, adoptCtxExports, composeFabric, processHostFor } = await importWorkerBundle({
  'packages/fabric/src/bindings.ts': ['NimbusLoadedEntrypoint'],
  'packages/fabric/src/composition.ts': ['adoptCtxExports', 'composeFabric'],
  'packages/worker/src/loaders/process-host.ts': ['processHostFor'],
});

const assembled = [];
composeFabric({
  supervisorEntrypoint: 'SupervisorRPC',
  stagedBootAssembler: async (_env, stage) => {
    assembled.push(stage);
    return { compatibilityDate: '2026-04-21', mainModule: 'runner.js', modules: { 'runner.js': `export default { fetch() {} }; // ${stage.argv.join(' ')}` } };
  },
});

const loads = [];
const fetches = [];
const env = { LOADER: {
  get(key, callback) {
    const code = callback();
    loads.push({ key, code });
    return {
      async getEntrypoint() {
        return { async fetch(request) { fetches.push(request); return new Response(null, { status: 200, headers: { 'x-exit': '0' } }); }, [Symbol.dispose]() {} };
      },
    };
  },
} };
const supervisor = { doId: 'session', pid: 7, writerId: 'writer', bindingKind: 'process', route: { supervisorEntrypoint: 'SupervisorRPC' } };
const hop = Object.assign(Object.create(NimbusLoadedEntrypoint.prototype), {
  ctx: {
    props: { key: 'nimbus-run:session:7:writer', name: null, depth: 0, stage: { argv: ['opencode', '--version'] }, supervisor },
    exports: { SupervisorRPC: ({ props }) => ({ binding: props }) },
    waitUntil() {},
  },
  env,
});

const run = new AbortController();
const response = await hop.fetch(new Request('http://nimbus-runtime.local/run', { method: 'POST', body: '{}', signal: run.signal }));
assert.equal(response.headers.get('x-exit'), '0', 'the run\'s answer is handed back');

assert.equal(loads.length, 1);
assert.deepEqual(assembled, [{ argv: ['opencode', '--version'] }], 'assembled from its stage, here');
const code = await loads[0].code;
assert.equal(code.mainModule, 'runner.js', 'entered by its own fetch');
assert.match(code.modules['runner.js'], /opencode --version/, 'the program\'s own modules ride unchanged');
assert.deepEqual(code.env?.SUPERVISOR, { binding: supervisor }, 'its SUPERVISOR is the binding minted here, from its props');
assert.equal(typeof hop.run, 'undefined', 'and the hop takes no run, so no stub of its host\'s');

assert.equal(fetches.length, 1);
assert.equal(await fetches[0].text(), '{}');
run.abort(new Error('killed'));
assert.equal(fetches[0].signal.aborted, true, 'the run\'s end reaches the program\'s request through the hop');

// From its host: a staged run's SUPERVISOR is minted in the hop from the
// props its host opened the run with, so it carries that run.
{
  const mint = ({ props }) => ({ binding: props });
  adoptCtxExports({
    SupervisorRPC: mint,
    NimbusLoadedEntrypoint: ({ props }) => Object.assign(Object.create(NimbusLoadedEntrypoint.prototype), {
      ctx: { props, exports: { SupervisorRPC: mint }, waitUntil() {} },
      env,
    }),
  });
  const host = processHostFor({ id: { toString: () => 'staged-host' }, waitUntil() {} }, env, () => { throw new Error('a one-shot reads no disk'); });
  const writerId = crypto.randomUUID();
  const exit = await host.runOnce({
    pid: 9, writerId, onWriterActivated() {},
    request: new Request('http://run.local/', { method: 'POST', body: '{}' }),
    code: async () => ({ stage: { argv: ['opencode', 'run'] } }),
  }, async (answer) => answer.headers.get('x-exit'));
  assert.equal(exit, '0');
  const { binding } = (await loads.at(-1).code).env.SUPERVISOR;
  assert.deepEqual({ bindingKind: binding.bindingKind, writerId: binding.writerId, pid: binding.pid, doId: binding.doId },
    { bindingKind: 'process', writerId, pid: 9, doId: 'staged-host' }, 'the staged program\'s SUPERVISOR is the run its host opened');
}

console.log('staged-one-shot-run: ok');
