#!/usr/bin/env bun
// A facet task whose request body does not parse as it arrived fails saying
// so, for each task that reads one: a bash step and a python REPL step,
// through the pool's generated entry, and a process's run, through the
// one-shot entry, with the program a launch generates. Requests to facets
// are teed for their retries, the primitive whose response bodies reached
// the browser with a 16 KiB block out of order; every task reads its body as
// JSON, so such a body fails there, and the failure names the body. Any
// other failure of the task is left as it was, and the callers' reader of a
// pool's answer (facetAnswer) throws what the task failed with.

import assert from 'node:assert/strict';
import { bashRequestStep } from '../../packages/core/src/runtime/facet-tasks.ts';
import { facetAnswer } from '../../packages/core/src/runtime/facet-host.ts';
import { pythonReplStepRequestFn } from '../../packages/worker/src/runtime/repl-facet-tasks.ts';
import { assembleLoaderWorkerModuleSource } from '../../packages/fabric/src/isolate-pool.ts';
import { enteredByRun } from '../../packages/fabric/src/one-shot-entry.ts';
import { importModuleSet } from './lib/module-map-bundle.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { adoptSessionSupervisor, oneShotManager, runnerLoader } from './lib/one-shot-runner.mjs';

const request = (body) => new Request('https://facet.internal/step', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': String(new TextEncoder().encode(body).length) },
  body,
});
const sent = JSON.stringify({ step: 'x'.repeat(40_000) });
// A 16 KiB block moved, as a teed body was seen to arrive: the same length, not JSON.
const moved = sent.slice(0, 8) + sent.slice(16_392, 32_776) + sent.slice(8, 16_392) + sent.slice(32_776);
assert.equal(moved.length, sent.length);
// The failure as a task meets it, reading that body.
const parse = await request(moved).json().then(() => null, (error) => error.message);
const named = (failure) => typeof failure === 'string' && failure.endsWith(parse) && failure !== parse && failure.includes(String(sent.length));

/** A pool's entry for `fn`, as IsolatePool generates it; its answer read as the callers read it. */
async function pooled(fn) {
  const { default: Entry } = await importModuleSet({ 'worker.js': assembleLoaderWorkerModuleSource({ fnSource: fn.toString(), hasBindings: true }) }, 'worker.js');
  return (body) => new Entry({}, {}).fetch(request(body)).then(facetAnswer).then((value) => ({ value }), (error) => ({ failure: error.message }));
}

// ── a bash step ──────────────────────────────────────────────────────────
{
  Reflect.set(globalThis, '__bashStep', async (args) => {
    if (args.own) throw new SyntaxError('Unexpected token in JSON at position 3');
    return { state: 'exited', exitCode: 0, stdout: '', stderr: '' };
  });
  const step = await pooled(bashRequestStep);
  assert.equal((await step(sent)).value.state, 'exited', 'a body as sent is the step\'s');
  const changed = await step(moved);
  assert.ok(named(changed.failure), `a body that does not parse is named: ${JSON.stringify(changed)}`);
  assert.deepEqual(await step(JSON.stringify({ own: true })), { failure: 'Unexpected token in JSON at position 3' }, 'the step\'s own JSON failure is its own');
  Reflect.deleteProperty(globalThis, '__bashStep');
  console.log('  ✓ a bash step');
}

// ── a python REPL step ───────────────────────────────────────────────────
{
  const step = await pooled(pythonReplStepRequestFn);
  const changed = await step(moved);
  assert.ok(named(changed.failure), `a body that does not parse is named: ${JSON.stringify(changed)}`);
  assert.deepEqual(await step(JSON.stringify({ step: 1 })), { failure: 'Python REPL request must contain userCode' }, 'the step\'s own failure is its own');
  console.log('  ✓ a python REPL step');
}

// ── a process's run: the program a launch generates, entered by run ──────
{
  const authority = createAuthority();
  adoptSessionSupervisor(authority.host, () => {});
  let program = null;
  const manager = oneShotManager('task-body', {
    host: authority.host,
    rawVfs: authority.rawVfs,
    loader: runnerLoader('task-body', { onImported: (config) => { program = config; } }),
  });
  authority.kfs.mkdir('/home/user/task-body');
  const launched = await manager.exec('process.stdout.write("ran")', { cwd: '/home/user/task-body', captureOutput: true });
  assert.equal(launched.stdout, 'ran', launched.stderr);
  const entered = enteredByRun(program);
  const { default: Entry } = await importModuleSet(entered.modules, entered.mainModule);
  const failure = await new Entry({ abort() {} }, {}).run(request(moved), null, () => new Promise(() => {})).then(() => null, (error) => error.message);
  assert.ok(named(failure), `a run body that does not parse is named: ${failure}`);
  console.log('  ✓ a process\'s run');
}
console.log('task-body-attribution: ok');
