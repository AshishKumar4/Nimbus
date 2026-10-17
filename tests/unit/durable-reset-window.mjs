import assert from 'node:assert/strict';
import { afterReset } from '../behavioral/durable/_reset-window.mjs';
const reset = new Error('Nimbus remote RPC 500: Application called abort() to reset Durable Object.');
let calls = 0;
assert.equal(await afterReset(async () => { if (++calls < 2) throw reset; return 'ready'; }), 'ready');
assert.equal(calls, 2);
const unrelated = new Error('Internal server error');
await assert.rejects(afterReset(async () => { throw unrelated; }), (error) => error === unrelated);
await assert.rejects(afterReset(async () => { throw reset; }, 0), (error) => error === reset);
console.log('ok - intentional reset window retries only the platform abort error, bounded');

// The reset is graded by its effect, a new incarnation; the abort's own
// answer only by being one a reset can give.
const { ABORT_ANSWERED, ABORT_TORN_DOWN, resetInstance } = await import('../behavioral/durable/_reset-window.mjs');
let world;
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/s/reset/api/_diag/abort') {
      world.aborted = true;
      return new Response(null, { status: world.abortStatus });
    }
    if (pathname === '/s/reset/api/_diag/memory') {
      if (world.aborted && world.ends && world.down-- > 0) return new Response('Application called abort() to reset Durable Object.', { status: 500 });
      if (world.aborted && world.ends) world.gen = world.next;
      return Response.json({ hib: { isolateGen: world.gen } });
    }
    return new Response('not found', { status: 404 });
  },
});
const resetWith = (abortStatus, ends, down = 0) => {
  world = { gen: 4, next: 5, abortStatus, ends, down, aborted: false };
  return resetInstance('reset', { base: `http://127.0.0.1:${server.port}`, budgetMs: 1_500 });
};
try {
  assert.deepEqual(await resetWith(204, true), { ok: true, answer: ABORT_ANSWERED, detail: 'abort answered 204; incarnation 4 → 5' });
  assert.deepEqual(await resetWith(500, true, 2), { ok: true, answer: ABORT_TORN_DOWN, detail: 'abort answered 500; incarnation 4 → 5' },
    'a 500 from the instance the abort tore down is the reset');
  assert.equal((await resetWith(500, false)).ok, false, 'a 500 from an instance that lives on is red');
  assert.equal((await resetWith(204, false)).ok, false, 'an abort that answers and resets nothing is red');
  assert.equal((await resetWith(503, true)).ok, false, 'an answer a reset cannot give is red, though the instance ended');
} finally {
  server.stop(true);
}
console.log('ok - a reset is graded by its new incarnation; a torn-down 500 is not a failure, a live one is');
