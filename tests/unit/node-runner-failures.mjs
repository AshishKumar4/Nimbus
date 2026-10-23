#!/usr/bin/env bun
// What a runner call answers when it loses its runner (FacetManager.runnerRun,
// facets/runners.ts). Each cause has its own code, which the SDK documents:
// the platform's CPU and memory kills, the call's own wall limit, a kill of
// the runner's process, and any other failure of its worker. Every answer
// tells the caller its next call is fresh, except a wall limit that came
// while the call still waited for a Dynamic Worker: that call ran nothing,
// and its runner keeps its state. Two callers who ask for the same options,
// in whatever order, ask for one runner.

import assert from 'node:assert/strict';
import { RunnerCallEnded, runnerExited, runnerFailure, runnerOptionsKey } from '../../packages/worker/src/facets/runners.ts';

const CPU_MS = 1_000;
for (const [label, error, sent, code, fresh] of [
  ['the platform\'s CPU kill', new Error('Worker exceeded CPU time limit.'), true, 'ERR_NIMBUS_RUNNER_CPU_LIMIT', true],
  ['the platform\'s memory kill', new Error('Worker exceeded memory limit.'), true, 'ERR_NIMBUS_RUNNER_MEMORY_LIMIT', true],
  ['the wall limit, while the code ran', new RunnerCallEnded('timeout', 500), true, 'ERR_NIMBUS_RUNNER_TIMEOUT', true],
  ['the wall limit, while the call waited for a worker', new RunnerCallEnded('timeout', 500), false, 'ERR_NIMBUS_RUNNER_TIMEOUT', false],
  ['a kill of its process', new RunnerCallEnded('killed'), true, 'ERR_NIMBUS_RUNNER_KILLED', true],
  ['any other failure of its worker', new Error('Network connection lost.'), true, 'ERR_NIMBUS_RUNNER_LOST', true],
]) {
  const answer = runnerFailure(error, CPU_MS, sent);
  assert.equal(answer.code, code, label);
  assert.equal(answer.name, 'NimbusRunnerError', label);
  assert.equal(answer.message.includes('the next call runs in a fresh runner'), fresh, `${label}: ${answer.message}`);
}
assert.ok(runnerFailure(new Error('Worker exceeded CPU time limit.'), CPU_MS, true).message.includes(`${CPU_MS} ms`), 'a CPU kill names the limit the call ran under');
assert.ok(runnerFailure(new Error('Network connection lost.'), CPU_MS, true).message.includes('Network connection lost.'), 'any other failure keeps the platform\'s words');
assert.equal(runnerExited(3).code, 'ERR_NIMBUS_RUNNER_EXITED');

assert.equal(
  runnerOptionsKey({ cwd: '/w', env: { A: '1', B: '2' } }),
  runnerOptionsKey({ env: { B: '2', A: '1' }, cwd: '/w' }),
  'the same options, in another order, are the same runner',
);
for (const other of [{ cwd: '/x', env: { A: '1', B: '2' } }, { cwd: '/w', env: { A: '1' } }, { cwd: '/w', env: { A: '1', B: '2' }, execId: 'job' }]) {
  assert.notEqual(runnerOptionsKey({ cwd: '/w', env: { A: '1', B: '2' } }), runnerOptionsKey(other), JSON.stringify(other));
}
console.log('node-runner-failures: ok');
