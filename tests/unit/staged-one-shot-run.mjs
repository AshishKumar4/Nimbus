#!/usr/bin/env bun
// A staged one-shot (opencode): its ~23 MB module map is assembled from its
// stage in the stateless NimbusLoadedEntrypoint, on that loader's miss, never
// in the host, and its SUPERVISOR is a binding minted there, from the props
// its host handed the hop. No stub of the host's crosses the hop into the
// program: one that did (the host's capability) reset the host mid-run.

import assert from 'node:assert/strict';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const { NimbusLoadedEntrypoint, composeFabric } = await importWorkerBundle({
  'packages/fabric/src/bindings.ts': ['NimbusLoadedEntrypoint'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
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
        return { async fetch(request) { fetches.push(request); return new Response(null, { status: 200, headers: { 'x-exit': '0' } }); } };
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

const response = await hop.fetch(new Request('http://nimbus-runtime.local/run', { method: 'POST', body: '{}' }));
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

console.log('staged-one-shot-run: ok');
