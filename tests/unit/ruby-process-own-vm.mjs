#!/usr/bin/env bun
// A one-shot Ruby process (__rubyRunProcess, a warm worker's next process)
// runs in one VM, its own: it boots one, and every evaluation of the run,
// the drive of its body fiber included, goes to that one. Two processes
// back to back boot one VM each. A prompt line (__rubyRun) uses the one VM
// its process keeps, booting none.
//
// Driven through the runner's own preamble over the WASI host (worker
// wasi/preamble.ts), the VM's boot and its evaluations stood in for.
//
// Red before: the drive of a one-shot's body fiber resumed "the" VM, the
// one a resident keeps, so a one-shot booted a second VM, and Ruby failed
// every one-shot "failed to allocate memory" (a throwaway of the first
// warm-facet build).

import assert from 'node:assert/strict';
import { RUBY_RUNNER_PREAMBLE_TAIL } from '../../packages/core/src/runtime/ruby-runner.ts';
import { wasiOutputRelay } from '../../packages/core/src/runtime/wasi/stdio.ts';
import { outputControlReader } from '../../packages/core/src/runtime/wasi/output-control.ts';
import { memorySupervisor } from './lib/descriptor-supervisor.mjs';
import { loadWasiPreamble } from './lib/wasi-authority.mjs';

const P = await loadWasiPreamble();
const CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
/** Each VM booted, and the VM each evaluation went to. */
const booted = [];
const evaluatedIn = [];
Object.assign(globalThis, {
  __wasiSupervisorOutput: wasiOutputRelay,
  __wasiOutputControl: outputControlReader,
  __wasiSettled: async (result) => result,
  __nimbusRubySupervisor: Object.assign(memorySupervisor(), { stdout: async () => {}, stderr: async () => {} }),
  __bootVm: () => {
    const vm = { ok: true, rubyInitialized: true, reachedJs: () => false, id: booted.length + 1 };
    booted.push(vm);
    return vm;
  },
  __evaluate: (vm) => {
    evaluatedIn.push(vm.id);
    return { status: 0 };
  },
});
new Function('__wasiInitFS', '__wasiAdoptSupervisor', '__wasiReusable', 'globalThis', `${RUBY_RUNNER_PREAMBLE_TAIL}
async function __nimbusRubyBoot() { return globalThis.__bootVm(); }
async function __nimbusRubyEval(boot, code) { return globalThis.__evaluate(boot); }`)(P.__wasiInitFS, P.__wasiAdoptSupervisor, P.__wasiReusable, globalThis);

const args = (pid) => ({ userCode: 'puts 1', requires: [], rbArgv: [], userEnv: {}, progName: '-e', binName: 'ruby', cwd: '/home/user', supervisorPid: pid, cred: CRED });

const first = await globalThis.__rubyRunProcess(args(11));
assert.equal(first.error, undefined, first.error);
assert.deepEqual(booted.map((vm) => vm.id), [1], 'a one-shot boots one VM');
assert.ok(evaluatedIn.length > 0 && evaluatedIn.every((id) => id === 1), `every evaluation of it goes to its own VM: ${JSON.stringify(evaluatedIn)}`);
assert.equal(first.reusable, true, 'a clean run that never reached JavaScript leaves its worker to the next process');
console.log('  ✓ a one-shot runs in the one VM it boots');

evaluatedIn.length = 0;
const second = await globalThis.__rubyRunProcess(args(12));
assert.equal(second.error, undefined, second.error);
assert.deepEqual(booted.map((vm) => vm.id), [1, 2], 'the next one-shot boots its own');
assert.ok(evaluatedIn.length > 0 && evaluatedIn.every((id) => id === 2), `and runs in it alone: ${JSON.stringify(evaluatedIn)}`);
console.log('  ✓ the next one-shot on the worker boots and runs in a VM of its own');

globalThis.__rubyBootstrap = Promise.resolve({ ok: true, rubyInitialized: true, reachedJs: () => false, id: 'kept' });
evaluatedIn.length = 0;
const line = await globalThis.__rubyRun(args(13));
assert.equal(line.error, undefined, line.error);
assert.equal(booted.length, 2, 'a prompt line boots none');
assert.ok(evaluatedIn.length > 0 && evaluatedIn.every((id) => id === 'kept'), `it runs in the VM its process keeps: ${JSON.stringify(evaluatedIn)}`);
console.log('  ✓ a prompt line runs in the VM its process keeps');
console.log('ruby-process-own-vm: ok');
