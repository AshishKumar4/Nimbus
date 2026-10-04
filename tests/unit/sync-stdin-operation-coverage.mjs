#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SUPERVISOR_OPS } from '../../packages/core/src/workspace/supervisor-op.ts';
import { REPLAY_OPERATION_POLICY, operationPolicy } from '../../packages/worker/src/runtime/stop-replay-policy.ts';
import { ReplayJournal, answerDigest } from '../../packages/worker/src/runtime/stop-replay-journal.ts';
import { mock } from 'bun:test';
import { REPLAY_PUBLIC_METHOD_POLICY } from '../../packages/worker/src/runtime/stop-replay-policy.ts';
mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));
const { SupervisorRPC } = await import('../../packages/worker/src/session/supervisor-rpc.ts');
const publicMethods = Object.getOwnPropertyNames(SupervisorRPC.prototype).filter((name) => name !== 'constructor' && !name.startsWith('_'));
function checkPublic(name, method) {
  const explicit = REPLAY_PUBLIC_METHOD_POLICY[name];
  if (explicit) return;
  assert.ok(operationPolicy(name), 'unclassified public SupervisorRPC method: ' + name);
  assert.match(String(method), /this\._(?:op|fsOp|fsRead|fsMutation|resent)\s*\(/, name + ' bypasses the session journal');
}
for (const name of publicMethods) checkPublic(name, SupervisorRPC.prototype[name]);
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
console.log(`sync-stdin-operation-coverage: ${SUPERVISOR_OPS.length} ops and ${publicMethods.length} public RPC methods classified; new methods/ops fail closed`);
