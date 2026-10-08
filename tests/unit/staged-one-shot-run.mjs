#!/usr/bin/env bun
// A staged one-shot (opencode) runs like every other one-shot: by `run`,
// with its host's capability as its SUPERVISOR. Its ~23 MB module map is
// assembled from its stage in the stateless NimbusLoadedEntrypoint, on that
// loader's miss, never in the host; that hop hands the run on, capability
// and `ended` included, and mints no binding of its own.

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
const runs = [];
const env = { LOADER: {
  get(key, callback) {
    const code = callback();
    loads.push({ key, code });
    return {
      async getEntrypoint() {
        return { async run(...args) { runs.push(args); return new Response(null, { status: 200, headers: { 'x-exit': '0' } }); } };
      },
    };
  },
} };
const hop = Object.assign(Object.create(NimbusLoadedEntrypoint.prototype), {
  ctx: { props: { key: 'nimbus-run:session:7:writer', name: null, depth: 0, stage: { argv: ['opencode', '--version'] } }, exports: {}, waitUntil() {} },
  env,
});

const capability = { capability: 'the host\'s' };
const ended = async () => null;
const response = await hop.run(new Request('http://nimbus-runtime.local/run', { method: 'POST', body: '{}' }), capability, ended);
assert.equal(response.headers.get('x-exit'), '0', 'the run\'s answer is handed back');

assert.equal(loads.length, 1);
assert.deepEqual(assembled, [{ argv: ['opencode', '--version'] }], 'assembled from its stage, here');
const code = await loads[0].code;
assert.equal(code.mainModule, 'nimbus-one-shot.js', 'entered by run');
assert.match(code.modules['nimbus-one-shot.js'], /import program from "\.\/runner\.js"/);
assert.match(code.modules['runner.js'], /opencode --version/, 'the program\'s own modules ride unchanged');
assert.equal(code.env?.SUPERVISOR, undefined, 'and no binding: its SUPERVISOR is the run\'s capability');

assert.equal(runs.length, 1);
const [request, supervisor, handedEnded] = runs[0];
assert.equal(supervisor, capability, 'the host\'s capability is handed on');
assert.equal(handedEnded, ended, 'and so is how the run hears it ended');
assert.equal(await request.text(), '{}');

console.log('staged-one-shot-run: ok');
