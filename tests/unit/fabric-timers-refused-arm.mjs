#!/usr/bin/env bun
// A timer that could not be armed is said so, once, to the caller that has
// to act on it.
//
// schedule answers false when the map or the alarm could not be written.
// MaximumSquirrel (on 6d7c95767): a failed alarm write could reject with
// nothing listening when the map write failed first; dispatch did not await
// its re-arm; and the launch turn and the outbox ignored a false, so what
// they armed would never fire. Timers.arm retries a refused arm, then throws.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { timers, TIMER_REASONS_KEY } from '../../packages/fabric/src/timers.ts';
import { outbox } from '../../packages/fabric/src/outbox.ts';
import { PacedWork } from '../../packages/fabric/src/turn-budget.ts';

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(String(reason?.message ?? reason)); });
const settle = () => new Promise((r) => setTimeout(r, 20));

function createCtx({ failPut = () => false, failAlarm = () => false } = {}) {
  const db = new Database(':memory:');
  const kv = new Map();
  const alarms = [];
  return {
    kv,
    alarms,
    storage: {
      sql: {
        exec(query, ...params) {
          if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE|DROP)/i.test(query)) { db.query(query).run(...params); return []; }
          return db.query(query).all(...params);
        },
      },
      async get(key) { return kv.get(key); },
      async put(key, value) { if (failPut(key)) throw new Error('map write failed'); kv.set(key, value); },
      async delete(key) { return kv.delete(key); },
      async setAlarm(at) { if (failAlarm(at)) throw new Error('alarm write failed'); alarms.push(at); },
    },
  };
}

// ── 1. both writes failing is one false, and no stray rejection ────────────
{
  const ctx = createCtx({ failPut: () => true, failAlarm: () => true });
  assert.equal(await timers({}, ctx).schedule('both', Date.now() + 1000), false);
  await settle();
  assert.deepEqual(unhandled, [], 'neither failure is left unhandled');
}

// ── 2. dispatch waits for its re-arm, and its failure is not stray ─────────
{
  let failing = false;
  const ctx = createCtx({ failAlarm: () => failing });
  const host = {};
  const now = Date.now();
  ctx.kv.set(TIMER_REASONS_KEY, { due: now - 1, later: now + 60_000 });
  failing = true;
  await timers(host, ctx).dispatch({ due: () => undefined });
  await settle();
  assert.deepEqual(unhandled, [], 'a failed re-arm surfaces in dispatch, not as a stray rejection');
  assert.deepEqual(ctx.kv.get(TIMER_REASONS_KEY), { later: now + 60_000 }, 'the map is still written');
}

// ── 3. arm retries a refused arm, then throws ──────────────────────────────
{
  let refusals = 2;
  const ctx = createCtx({ failAlarm: () => refusals-- > 0 });
  const t = timers({}, ctx);
  await t.arm('retried', Date.now() + 1000);
  assert.equal(ctx.alarms.length, 1, 'armed on the third attempt');

  const never = createCtx({ failAlarm: () => true });
  await assert.rejects(timers({}, never).arm('never', Date.now() + 1000), /'never' timer could not be armed/);
}

// ── 4. a launch waiting on a turn that cannot be armed fails, not hangs ────
{
  const ctx = createCtx({ failAlarm: () => true });
  const host = {};
  const paced = new PacedWork(ctx, { requestTurn: (at) => timers(host, ctx).arm('resident-launch', Math.max(Date.now(), at ?? 0)) });
  const turn = paced.nextTurn(Promise.resolve());
  const outcome = await Promise.race([turn.then(() => 'resumed', (e) => e.message), new Promise((r) => setTimeout(() => r('hung'), 2000))]);
  assert.match(outcome, /'resident-launch' timer could not be armed/);
}

// ── 5. an outbox whose arm is refused says so ──────────────────────────────
{
  const ctx = createCtx({ failAlarm: () => true });
  const box = outbox({}, ctx, 'refused', { send: async () => {} });
  await assert.rejects(box.queue({ hello: 1 }), /'refused' timer could not be armed|could not be armed/);
}

await settle();
assert.deepEqual(unhandled, [], `no stray rejections: ${unhandled.join('; ')}`);
console.log('fabric-timers-refused-arm: ok');
