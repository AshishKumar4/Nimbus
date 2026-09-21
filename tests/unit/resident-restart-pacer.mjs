import assert from 'node:assert/strict';
import { PacedWork } from '../../packages/fabric/src/turn-budget.ts';

const requested = [];
const pacer = new PacedWork({}, { requestTurn: (at) => requested.push(at) });
const due = Date.now() + 30;
let resumed = false;
const delayed = pacer.nextTurn(Promise.resolve(), due).then(() => { resumed = true; });
const immediate = pacer.nextTurn(Promise.resolve());
await pacer.pump();
await immediate;
assert.equal(resumed, false, 'an unrelated earlier alarm cannot defeat restart backoff');
assert.equal(requested.at(-1), due, 'remaining backoff re-arms the existing alarm');
await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()) + 5));
await pacer.pump();
await delayed;
assert.equal(resumed, true);
assert.equal(pacer.hasPending, false);
console.log('ok - restart backoff uses the existing pacer and respects earlier alarms');

const rejected = new Error('host schedule refused');
let failSchedule = true;
const retryable = new PacedWork({}, {
  requestTurn: async () => { if (failSchedule) throw rejected; },
});
await assert.rejects(retryable.nextTurn(Promise.resolve()), error => error === rejected);
assert.equal(retryable.hasPending, false, 'failed initial scheduling removes its waiter');
failSchedule = false;
const retry = retryable.nextTurn(Promise.resolve());
await retryable.pump();
await retry;

const futurePacer = new PacedWork({}, {
  requestTurn: async () => { if (failSchedule) throw rejected; },
});
const future = futurePacer.nextTurn(Promise.resolve(), Date.now() + 60_000);
const futureFailure = assert.rejects(future, error => error === rejected);
let dueFinished = false;
const dueWork = futurePacer.nextTurn(Promise.resolve()).then(() => { dueFinished = true; });
await Promise.resolve();
failSchedule = true;
await assert.rejects(futurePacer.pump(), error => error === rejected);
await Promise.all([futureFailure, dueWork]);
assert.equal(dueFinished, true, 'failed future scheduling must not strand due work');
assert.equal(futurePacer.hasPending, false);

const closing = new PacedWork({}, { requestTurn: async () => {} });
const parked = closing.nextTurn(Promise.resolve());
const canceled = assert.rejects(parked, /closed/);
closing.close();
await canceled;
await assert.rejects(closing.nextTurn(Promise.resolve()), /closed/);
assert.equal(closing.hasPending, false);
console.log('ok - async schedule failure propagates, explicit retry works, and close cancels parked work');
