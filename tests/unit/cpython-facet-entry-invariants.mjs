#!/usr/bin/env bun
// Execute every compiled CPython entry against its real guest seam: publishing
// the supervisor must precede adoption, and both must precede entering the VM.
import assert from 'node:assert/strict';
import * as core from '../../packages/core/src/runtime/compiled-bodies.generated.ts';
import * as worker from '../../packages/worker/src/loaders/compiled-bodies.generated.ts';

const entries = Object.entries({ ...core, ...worker }).filter(([, task]) => task?.kind === 'nimbus-facet-task' && /__cpython(?:Run|ReplRun)/.test(task.source));
assert.ok(entries.length >= 2, 'discover the one-shot and REPL compiled entries');
const keys = ['__cpythonRun', '__cpythonReplRun', '__wasiAdoptSupervisor', '__nimbusPySupervisor'];
const before = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
try {
  for (const [name, task] of entries) {
    const supervisor = {};
    const seen = [];
    delete globalThis.__nimbusPySupervisor;
    globalThis.__wasiAdoptSupervisor = (got) => {
      assert.equal(got, supervisor, name);
      assert.equal(globalThis.__nimbusPySupervisor, supervisor, `${name}: publish before adoption`);
      seen.push('adopt');
    };
    globalThis.__cpythonRun = globalThis.__cpythonReplRun = async () => {
      assert.deepEqual(seen, ['adopt'], `${name}: adopt before entering Python`);
      seen.push('run');
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    };
    const run = new Function(`return (${task.source});`)();
    const result = await run(new Request('https://python.test/', { method: 'POST', body: JSON.stringify({ userCode: 'pass' }) }), { SUPERVISOR: supervisor });
    assert.deepEqual(seen, ['adopt', 'run'], name);
    assert.equal((result instanceof Response ? await result.json() : result).stdout, 'ok');
    assert.doesNotMatch(task.source, /__wasiDrainPersist|__wasiRevalidateFS/, `${name}: no obsolete persist queue`);
  }
} finally {
  keys.forEach((key, index) => { if (before[index]) Object.defineProperty(globalThis, key, before[index]); else delete globalThis[key]; });
}
console.log(`cpython-facet-entry-invariants: ${entries.length} guest entries`);
