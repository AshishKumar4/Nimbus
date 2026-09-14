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
