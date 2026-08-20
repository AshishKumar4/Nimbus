#!/usr/bin/env bun
// The Actor's floor wiring — what loom promises an embedder never writes by
// hand again:
//
//   - CONSTRUCTOR IS SYNCHRONOUS: generation adoption and cold-start work
//     run on the first turn the actor owns, never the init gate (a gate
//     callback still pending at ~30s resets the object).
//   - GENERATION: adopted once per incarnation; a fresh ctx over the same
//     storage is the next incarnation and gets the next counter.
//   - FENCED WORK: a journal row a previous incarnation left behind is
//     re-driven on the first turn, exactly once.
//   - ONE ALARM, MANY REASONS: alarm() dispatches fabric's reason map with
//     alarmInfo riding through; schedules and outboxes are reasons in the
//     same map.
//   - HIBERNATION: `static options = { hibernate: true }` also applies
//     fabric's ws config (ping/pong auto-response + event timeout).
//   - COMPOSITION: `static options = { fabric }` reaches composeFabric;
//     ctx.exports is captured in the constructor.
//
// The suite drives the REAL partyserver Server under a virtual
// `cloudflare:workers` module — see lib/loom-harness.mjs.

import assert from 'node:assert/strict';
import { z } from 'zod/v4';
import {
  loadLoom,
  createBacking,
  createActorCtx,
  fakeSocket,
  attachSocket,
  frames,
} from './lib/loom-harness.mjs';

const { Actor, callable } = await loadLoom();
const { supervisorEntrypointName } = await import('../../packages/fabric/src/composition.ts');
const { GENERATION_KEY } = await import('../../packages/fabric/src/generation.ts');
const { TIMER_REASONS_KEY } = await import('../../packages/fabric/src/timers.ts');
const { FENCED_WORK_KEY_PREFIX } = await import('../../packages/fabric/src/fenced-work.ts');
const { FixtureActor } = await import('./lib/loom-fixtures.ts');

const ALARM_INFO = { isRetry: false, retryCount: 0, scheduledTime: 0 };

// ── 1. Nothing async on the constructor path; the first turn pays ──────────

{
  const events = [];
  class Deferred extends Actor {
    constructor(ctx, env) {
      super(ctx, env);
      this.deferToColdStart(async () => { events.push('cold-start'); });
      events.push('constructed');
    }
    onStart() { events.push('onStart'); }
  }
  const ctx = createActorCtx();
  const actor = new Deferred(ctx, {});
  assert.deepEqual(events, ['constructed']);
  assert.equal(actor.generation, 0);
  assert.equal(ctx.backing.kv.get(GENERATION_KEY), undefined);

  // The first entry point initializes (partyserver's gate runs exactly
  // onStart), then pays the floor: generation adopted, cold-start drained.
  await actor.setName('test-actor');
  assert.deepEqual(events, ['constructed', 'onStart', 'cold-start']);
  assert.equal(actor.generation, 1);
  assert.equal(ctx.backing.kv.get(GENERATION_KEY), 1);

  // Idempotent within the incarnation.
  await actor.alarm(ALARM_INFO);
  assert.equal(actor.generation, 1);

  // A fresh ctx over the same storage is the NEXT incarnation.
  const wokenCtx = createActorCtx({ backing: ctx.backing });
  const woken = new Deferred(wokenCtx, {});
  await woken.alarm(ALARM_INFO);
  assert.equal(woken.generation, 2);
}

// ── 2. Fenced work: a dead incarnation's launch is re-driven once ──────────

{
  const backing = createBacking();
  backing.kv.set(`${FENCED_WORK_KEY_PREFIX}7`, { pid: 7, command: 'vite dev', attempt: 0, phase: 'starting' });
  backing.kv.set(`${FENCED_WORK_KEY_PREFIX}205`, { pid: 205, command: 'own-gen', attempt: 0, phase: 'running' });

  const redriven = [];
  class Recovering extends Actor {
    constructor(ctx, env) {
      super(ctx, env);
      this.work = this.fenceWork({
        generationBase: () => 100,
        waitUntil: (p) => ctx.waitUntil(p),
        redrive: async (record, attempt) => { redriven.push({ pid: record.pid, attempt }); },
      });
    }
  }
  const ctx = createActorCtx({ backing });
  const actor = new Recovering(ctx, {});
  assert.deepEqual(redriven, []);

  await actor.alarm(ALARM_INFO);
  await ctx.drainWaits();
  // pid 7 is at or below the base (a previous incarnation's); pid 205 is
  // this incarnation's own and stays.
  assert.deepEqual(redriven, [{ pid: 7, attempt: 1 }]);
  assert.equal(backing.kv.has(`${FENCED_WORK_KEY_PREFIX}7`), false);
  assert.equal(backing.kv.has(`${FENCED_WORK_KEY_PREFIX}205`), true);

  // Once per incarnation: a second turn does not re-drive again.
  await actor.alarm(ALARM_INFO);
  await ctx.drainWaits();
  assert.equal(redriven.length, 1);
}

// ── 3. Timer reasons: embedder registration, alarmInfo, re-arm ─────────────

{
  const fires = [];
  class Ticker extends Actor {
    constructor(ctx, env) {
      super(ctx, env);
      this.registerTimerReason('ticker', (now, info) => {
        fires.push({ now, info });
        // Re-arm as already due, so the next alarm in this test fires it.
        return fires.length < 2 ? { rearmAt: now } : undefined;
      });
    }
  }
  const ctx = createActorCtx();
  const actor = new Ticker(ctx, {});
  await actor.timers.schedule('ticker', 50);
  assert.deepEqual(ctx.alarms, [50]);

  const info = { isRetry: true, retryCount: 3, scheduledTime: 50 };
  await actor.alarm(info);
  assert.equal(fires.length, 1);
  // The platform's alarm report reaches the handler.
  assert.deepEqual(fires[0].info, info);
  // The handler re-armed through its return value.
  const reasons = ctx.backing.kv.get(TIMER_REASONS_KEY);
  assert.equal(reasons.ticker, fires[0].now);

  await actor.alarm(ALARM_INFO);
  assert.equal(fires.length, 2);
  // Nothing remains: the reason map is deleted, no re-arm.
  assert.equal(ctx.backing.kv.get(TIMER_REASONS_KEY), undefined);

  // One handler per reason.
  assert.throws(() => actor.registerTimerReason('ticker', () => {}), /already registered/);
}

// ── 4. Schedules ride the alarm; callbacks get payload + alarmInfo ─────────

{
  const ctx = createActorCtx();
  const actor = new FixtureActor(ctx, {});
  const schedule = await actor.schedule(0, 'remind', { what: 'tea' });
  assert.equal(schedule.type, 'delayed');
  assert.ok(ctx.alarms.length > 0);

  const info = { isRetry: false, retryCount: 0, scheduledTime: schedule.time };
  await actor.alarm(info);
  assert.deepEqual(actor.events.filter((e) => e.startsWith('remind')), ['remind:{"what":"tea"}']);
  assert.equal(actor.lastInvocation.attempt, 1);
  assert.deepEqual(actor.lastInvocation.alarmInfo, info);
  assert.equal(actor.lastInvocation.schedule.id, schedule.id);
  assert.equal(await actor.getScheduleById(schedule.id), undefined);

  // The API surface: list, cancel, and enqueue-time method validation.
  const later = await actor.schedule(3600, 'remind');
  const interval = await actor.scheduleEvery(60, 'remind');
  assert.deepEqual((await actor.listSchedules()).map((s) => s.id).sort(), [later.id, interval.id].sort());
  assert.deepEqual((await actor.listSchedules({ type: 'interval' })).map((s) => s.id), [interval.id]);
  assert.equal(await actor.cancelSchedule(later.id), true);
  assert.equal(await actor.cancelSchedule(later.id), false);
  await assert.rejects(actor.schedule(1, 'noSuchMethod'), /this\.noSuchMethod is not a function/);

  // A callback that schedules from inside a dispatch must not deadlock on
  // the timer chain (the dispatcher already holds it).
  let chained = null;
  actor.chainNext = async function chainNext() {
    chained = await this.schedule(3600, 'remind', 'from-inside');
  };
  await actor.schedule(0, 'chainNext');
  await actor.alarm(ALARM_INFO);
  assert.ok(chained !== null);
  assert.ok((await actor.listSchedules()).some((s) => s.id === chained.id));
}

// ── 5. Failed schedule callbacks surface through onScheduleError ───────────

{
  const failures = [];
  class Flaky extends Actor {
    boom() { throw new Error('kaput'); }
    onScheduleError(schedule, error) { failures.push(`${schedule.callback}:${error.message}`); }
  }
  const ctx = createActorCtx();
  const actor = new Flaky(ctx, {});
  await actor.schedule(0, 'boom', undefined, { retry: { maxAttempts: 1 } });
  await actor.alarm(ALARM_INFO);
  assert.deepEqual(failures, ['boom:kaput']);
}

// ── 6. An outbox is a reason in the same map ────────────────────────────────

{
  const sent = [];
  const ctx = createActorCtx();
  class Mailer extends Actor {}
  const actor = new Mailer(ctx, {});
  const box = actor.outbox('mail', {
    maxAttempts: 3,
    baseMs: 1000,
    send: async (message) => { sent.push(message); return { status: 'sent' }; },
  });
  // Same name, same instance; the drain handler registered once.
  assert.equal(actor.outbox('mail', { maxAttempts: 1, baseMs: 1, send: async () => ({ status: 'sent' }) }), box);

  await box.queue({ to: 'owner', body: 'hi' });
  assert.ok(ctx.alarms.length > 0);
  await actor.alarm(ALARM_INFO);
  assert.deepEqual(sent, [{ to: 'owner', body: 'hi' }]);
}

// ── 7. Journals and typed connections come pre-wired ───────────────────────

{
  const ctx = createActorCtx();
  // Hibernating: the typed-connections view reads the platform's socket
  // list, which is where wake-shaped sockets live.
  class Hub extends Actor { static options = { hibernate: true }; }
  const actor = new Hub(ctx, {});

  const log = actor.journal('events');
  assert.equal(actor.journal('events'), log);
  const { id, admitted } = log.publish({ kind: 'boot' }, { dedupeKey: 'boot' });
  assert.equal(admitted, true);
  assert.equal(log.publish({ kind: 'boot' }, { dedupeKey: 'boot' }).admitted, false);
  const [claim] = log.claim({ leaseMs: 1000 });
  assert.equal(claim.id, id);
  assert.equal(claim.lease.done(), true);

  const socket = attachSocket(ctx, fakeSocket('device-1', { tags: ['device'] }));
  const typed = actor.connections(z.object({ device: z.string() }));
  const connection = typed.get('device-1');
  assert.ok(connection);
  typed.write(connection, { device: 'laptop' });
  assert.deepEqual(typed.read(connection), { device: 'laptop' });
  assert.deepEqual(typed.tags(connection), ['device-1', 'device']);
  assert.equal(typed.list('device').length, 1);
  assert.throws(() => typed.write(connection, { device: 42 }), /./);
  // partyserver's own metadata survives the write: the id still resolves.
  assert.equal(connection.id, 'device-1');
  // A raw attachment from a previous deploy is untrusted: read is null, not a cast.
  socket._attachment.__user = { junk: true };
  assert.equal(typed.read(connection), null);
}

// ── 8. Callable RPC over the connection, decorator syntax included ─────────

{
  const ctx = createActorCtx();
  const actor = new FixtureActor(ctx, {});
  const socket = attachSocket(ctx, fakeSocket('caller-1'));

  await actor.webSocketMessage(socket, JSON.stringify({ type: 'rpc', id: 'r1', method: 'greet', args: ['loom'] }));
  const reply = frames(socket).find((f) => f.id === 'r1');
  assert.deepEqual(reply, { type: 'rpc', id: 'r1', success: true, result: 'hello loom', done: true });

  await actor.webSocketMessage(socket, JSON.stringify({ type: 'rpc', id: 'r2', method: 'countTo', args: [2] }));
  const streamed = frames(socket).filter((f) => f.id === 'r2');
  assert.deepEqual(streamed.map((f) => [f.result, f.done]), [[1, false], [2, false], ['done', true]]);

  await actor.webSocketMessage(socket, JSON.stringify({ type: 'rpc', id: 'r3', method: 'hidden', args: [] }));
  const refused = frames(socket).find((f) => f.id === 'r3');
  assert.equal(refused.success, false);
  assert.match(refused.error, /is not callable/);
}

// ── 9. Hibernation config and fabric composition, from static options ──────

{
  class FakePair {
    constructor(request, response) { this.request = request; this.response = response; }
  }
  globalThis.WebSocketRequestResponsePair = FakePair;
  const configured = [];
  const timeouts = [];
  const ctx = createActorCtx();
  ctx.setWebSocketAutoResponse = (pair) => configured.push(pair);
  ctx.setHibernatableWebSocketEventTimeout = (ms) => timeouts.push(ms);

  class Hibernating extends Actor {
    static options = {
      hibernate: true,
      fabric: { supervisorEntrypoint: 'LoomTestSupervisor' },
    };
  }
  const actor = new Hibernating(ctx, {});
  assert.equal(actor.hibernation.autoResponseConfigured, true);
  assert.equal(actor.hibernation.timeoutSetMs, 5000);
  assert.deepEqual([configured[0].request, configured[0].response], ['ping', 'pong']);
  assert.deepEqual(timeouts, [5000]);
  // The composition reached fabric's one seam.
  assert.equal(supervisorEntrypointName(), 'LoomTestSupervisor');

  // Without the opt-in, nothing is configured.
  const plainCtx = createActorCtx();
  plainCtx.setWebSocketAutoResponse = () => { throw new Error('must not be called'); };
  class Plain extends Actor {}
  assert.equal(new Plain(plainCtx, {}).hibernation, null);
  delete globalThis.WebSocketRequestResponsePair;
}

// ── 10. onAlarm is embedder code: it runs AFTER the floor ───────────────────

{
  const order = [];
  class Alarmed extends Actor {
    constructor(ctx, env) {
      super(ctx, env);
      this.deferToColdStart(async () => { order.push('cold-start'); });
    }
    onAlarm() { order.push(`onAlarm:gen${this.generation}`); }
  }
  const ctx = createActorCtx();
  const actor = new Alarmed(ctx, {});
  await actor.alarm(ALARM_INFO);
  assert.deepEqual(order, ['cold-start', 'onAlarm:gen1']);
}

// ── 11. processes demands a declared substrate; facets lease ────────────────

{
  const ctx = createActorCtx();
  class Bare extends Actor {}
  const actor = new Bare(ctx, {});
  assert.throws(() => actor.processes, /override processHost\(\)/);
  // Typed connections need the hibernatable attachment; refuse, not corrupt.
  assert.throws(() => actor.connections(z.object({})), /needs hibernation/);

  // A leased facet retires on dispose: evicted, storage wiped.
  const calls = [];
  ctx.facets = {
    get: (name) => { calls.push(['get', name]); return { stub: name }; },
    abort: (name) => calls.push(['abort', name]),
    delete: (name) => calls.push(['delete', name]),
  };
  const lease = await actor.facets.acquire('worker-1', async () => ({ class: null }));
  assert.deepEqual(lease.stub, { stub: 'worker-1' });
  await lease.retire();
  assert.deepEqual(calls, [['get', 'worker-1'], ['abort', 'worker-1'], ['delete', 'worker-1']]);
}

console.log('loom-actor-floor: all assertions passed');
