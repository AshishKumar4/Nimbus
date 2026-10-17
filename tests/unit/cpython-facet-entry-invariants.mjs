#!/usr/bin/env bun
// Execute both compiled CPython entries against their real guest seam: each
// publishes the supervisor before adopting it, adopts it before entering the
// VM, and enters the VM with its caller's payload, returning what it answers.
import assert from 'node:assert/strict';
import { CPYTHON_RUN_TASK } from '../../packages/core/src/runtime/compiled-bodies.generated.ts';
import { PYTHON_REPL_TASK } from '../../packages/worker/src/loaders/compiled-bodies.generated.ts';

// The entries get, and the VM hands back, copies: an entry that changed
// either in place would change what it is checked against.
const payload = () => ({ userCode: 'print(6 * 7)', argv: ['-c', 'x'], cwd: '/home/user/app', env: { PYTHONHASHSEED: '0' } });
const answer = () => ({ stdout: '42\n', stderr: 'warned\n', exitCode: 3 });
const entries = [
  ['CPYTHON_RUN_TASK', CPYTHON_RUN_TASK, '__cpythonRun', (run, env) => run(payload(), env)],
  ['PYTHON_REPL_TASK', PYTHON_REPL_TASK, '__cpythonReplRun', async (run, env) =>
    (await run(new Request('https://python.test/', { method: 'POST', body: JSON.stringify(payload()) }), env)).json()],
];
const keys = ['__cpythonRun', '__cpythonReplRun', '__wasiAdoptSupervisor', '__nimbusPySupervisor'];
const before = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
try {
  for (const [name, task, vm, call] of entries) {
    const supervisor = {};
    const seen = [];
    for (const key of keys) delete globalThis[key];
    globalThis.__wasiAdoptSupervisor = (got) => {
      assert.equal(got, supervisor, name);
      assert.equal(globalThis.__nimbusPySupervisor, supervisor, `${name}: publish before adoption`);
      seen.push('adopt');
    };
    globalThis[vm] = async (args) => {
      assert.deepEqual(seen, ['adopt'], `${name}: adopt before entering Python`);
      seen.push(structuredClone(args));
      return answer();
    };
    const result = await call(new Function(`return (${task.source});`)(), { SUPERVISOR: supervisor });
    assert.deepEqual(seen, ['adopt', payload()], `${name}: the VM runs its caller's payload`);
    assert.deepEqual(result, answer(), `${name}: and the caller gets the VM's answer`);
  }
} finally {
  keys.forEach((key, index) => { if (before[index]) Object.defineProperty(globalThis, key, before[index]); else delete globalThis[key]; });
}
console.log('cpython-facet-entry-invariants: the one-shot and REPL entries');
