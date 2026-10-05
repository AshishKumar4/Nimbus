#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SUPERVISOR_OPS } from '../../packages/core/src/workspace/supervisor-op.ts';
import { REPLAY_OPERATION_POLICY, operationPolicy } from '../../packages/worker/src/runtime/stop-replay-policy.ts';
import { ReplayJournal, answerDigest } from '../../packages/worker/src/runtime/stop-replay-journal.ts';
import { mock } from 'bun:test';
import { REPLAY_PUBLIC_METHOD_POLICY } from '../../packages/worker/src/runtime/stop-replay-policy.ts';
import { spawnSync } from 'node:child_process';
class TrustedWorkerEntrypoint {}
mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: TrustedWorkerEntrypoint, DurableObject: class {}, RpcTarget: class {}, tracing: { startSpan: () => ({ end() {} }) } }));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
function effectiveMethods(Binding) {
  const methods = new Map();
  let prototype = Binding.prototype;
  for (; prototype && prototype !== TrustedWorkerEntrypoint.prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name === 'constructor' || name.startsWith('_') || methods.has(name)) continue;
      methods.set(name, Object.getOwnPropertyDescriptor(prototype, name).value);
    }
  }
  assert.equal(prototype, TrustedWorkerEntrypoint.prototype, 'binding must reach the trusted WorkerEntrypoint boundary');
  return methods;
}
const publicMethods = effectiveMethods(SupervisorRPC);
function checkPublic(name, method) {
  const explicit = REPLAY_PUBLIC_METHOD_POLICY[name];
  if (explicit) return;
  assert.ok(operationPolicy(name), 'unclassified public SupervisorRPC method: ' + name);
  assert.match(String(method), /this\._(?:op|fsOp|fsRead|fsMutation|resent)\s*\(/, name + ' bypasses the session journal');
}
function checkBinding(Binding) {
  for (const [name, method] of effectiveMethods(Binding)) checkPublic(name, method);
}
// Check the actual binding exports, not just the implementation constructor:
// an embedder may export a subclass with additional reachable RPC methods.
if (process.env.NIMBUS_COVERAGE_ENTRY) {
  const binding = (await import(new URL(process.env.NIMBUS_COVERAGE_ENTRY, import.meta.url).href)).SupervisorRPC;
  assert.equal(typeof binding, 'function', 'entry must export the supervisor binding');
  checkBinding(binding);
} else {
  // Each entry owns composition state; source and package/dist exports must
  // not be composed together in a single process merely for the coverage test.
  for (const entry of [
    '../../packages/worker/src/index.ts', '../../packages/sdk/src/worker.ts',
    '../../apps/probe/src/index.ts', '../../apps/hosted-demo/src/index.ts',
  ]) {
    const checked = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
      env: { ...process.env, NIMBUS_COVERAGE_ENTRY: entry }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(checked.status, 0, entry + ': ' + checked.stderr);
  }
}
class Intermediate extends TrustedWorkerEntrypoint { inheritedMethod() {} }
class InheritedBinding extends Intermediate {}
const WithMixin = (Base) => class extends Base { mixinMethod() {} };
class MixedBinding extends WithMixin(SupervisorRPC) {}
class DeployedBinding extends SupervisorRPC { subclassMethod() {} }
const negativeBindings = { inherited: InheritedBinding, mixin: MixedBinding, subclass: DeployedBinding };
for (const [name, Binding] of Object.entries(negativeBindings)) {
  if (!process.env.NIMBUS_COVERAGE_FIXTURE || process.env.NIMBUS_COVERAGE_FIXTURE === name) {
    assert.throws(() => checkBinding(Binding), /unclassified public/, name + ' binding must not escape coverage');
  }
}
assert.throws(() => checkPublic('futurePublicMethod', () => {}), /unclassified public/);
assert.throws(() => checkPublic('getPackument', () => {}), /bypasses the session journal/);

assert.deepEqual(Object.keys(REPLAY_OPERATION_POLICY).sort(), [...SUPERVISOR_OPS].sort(), 'every supervisor operation needs an explicit replay classification');
const j = new ReplayJournal(() => {});
j.start('a');
let dispatched = false;
assert.equal(operationPolicy('aFutureOperation'), undefined);
await j.handle('aFutureOperation', [], 'a', async () => { dispatched = true; });
assert.equal(dispatched, true, 'unknown operations continue normally');
assert.equal(j.replayable, false, 'unknown operations forbid a later replay');
assert.match(j.unreplayable, /aFutureOperation/);
// These used to disappear recursively, even inside ordinary config values.
for (const name of ['atime', 'atimeMs', 'atimeNs', 'lease', 'rev', 'epoch', 'acquired']) {
  assert.notEqual(answerDigest({ [name]: 1 }), answerDigest({ [name]: 2 }), name + ' is observable unless an operation-local rule proves otherwise');
}
for (const op of ['fsAcquired', 'fsAcquire', 'fsList']) {
  const p = operationPolicy(op);
  assert.equal(p.kind, 'observation');
  assert.notEqual(answerDigest(p.answer({ value: { rev: 1 }, paths: [], entries: [] })), answerDigest(p.answer({ value: { rev: 2 }, paths: [], entries: [] })));
}
for (const field of ['resize', 'signal', 'acquired', 'futureMetadata']) {
  const input = new ReplayJournal(() => {});
  input.start('a');
  await input.handle('cpReadStdin', [], 'a', async () => ({ data: new Uint8Array(), ended: false, [field]: {} }));
  assert.equal(input.replayable, false, field + ' must not leak around the stdin tape');
}
// Primitive refusals are inputs too: never collapse their types to strings,
// or mistake a rejection carrying undefined for a successful void reply.
for (const original of [undefined, null, 0, false]) {
  const failures = new ReplayJournal(() => {});
  failures.start('a');
  let caught = false;
  try { await failures.handle('stat', ['/failure'], 'a', () => Promise.reject(original)); }
  catch (error) { caught = true; assert.equal(error, original); }
  assert.equal(caught, true);
  failures.stopped(); failures.start('b');
  await assert.rejects(failures.handle('stat', ['/failure'], 'b', () => Promise.reject(String(original))), /answered differently/);
}
console.log(`sync-stdin-operation-coverage: ${SUPERVISOR_OPS.length} ops, ${publicMethods.size} effective public methods, four binding exports; inherited/mixin/subclass additions fail closed`);
