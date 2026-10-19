#!/usr/bin/env bun
// A facet task whose request body is not JSON as it arrived fails saying
// so, through either entry a task request comes by: the pool's fetch (a
// bash or python step) and a one-shot's run (a process). Every task reads
// its body as JSON, so a body changed in transit fails there; the message
// names the body and its length, and any other failure is left as it was.

import assert from 'node:assert/strict';
import { assembleLoaderWorkerModuleSource } from '../../packages/fabric/src/isolate-pool.ts';
import { ONE_SHOT_ENTRY, enteredByRun } from '../../packages/fabric/src/one-shot-entry.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';

const task = async (request) => {
  const args = await request.json();
  if (args.fail) throw new SyntaxError('the task itself failed');
  return Response.json(args);
};
const pool = (await importModuleSet({ 'worker.js': assembleLoaderWorkerModuleSource({ fnSource: task.toString(), hasBindings: false }) }, 'worker.js')).default;
const oneShot = (await importModuleSet(enteredByRun({ mainModule: 'program.js', modules: { 'program.js': `export default { fetch: ${task.toString()} };` } }).modules, ONE_SHOT_ENTRY)).default;

const request = (body) => new Request('https://facet.internal/step', { method: 'POST', headers: { 'content-length': String(new TextEncoder().encode(body).length) }, body });
/** What the entry answered: the task's JSON, or its failure's message. */
const entries = {
  async pool(body) {
    const response = await new pool({}, {}).fetch(request(body));
    const value = await response.json();
    return response.status === 200 ? { value } : { failure: value.__nimbusFacetError };
  },
  async 'one-shot'(body) {
    try {
      return { value: await (await new oneShot({ abort() {} }, {}).run(request(body), null, () => new Promise(() => {}))).json() };
    } catch (error) {
      return { failure: error.message };
    }
  },
};

const sent = JSON.stringify({ step: 'x'.repeat(40_000) });
// A 16 KiB block moved, as a teed body was seen to arrive: the same length, not JSON.
const moved = sent.slice(0, 8) + sent.slice(16_392, 32_776) + sent.slice(8, 16_392) + sent.slice(32_776);
assert.equal(moved.length, sent.length);

for (const [name, call] of Object.entries(entries)) {
  assert.deepEqual(await call(sent), { value: JSON.parse(sent) }, `${name}: a body as sent is the task's`);
  const changed = await call(moved);
  const parse = (() => { try { JSON.parse(moved); } catch (error) { return error.message; } })();
  assert.ok(changed.failure.endsWith(parse) && changed.failure !== parse && changed.failure.includes(String(sent.length)),
    `${name}: the parse failure is attributed to the body and its length: ${changed.failure}`);
  assert.deepEqual(await call(JSON.stringify({ fail: true })), { failure: 'the task itself failed' }, `${name}: another failure is the task's own`);
  console.log(`  ✓ ${name}: a task body that is not JSON as it arrived says so`);
}
console.log('task-body-attribution: ok');
