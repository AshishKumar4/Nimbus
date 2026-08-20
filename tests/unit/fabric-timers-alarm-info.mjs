#!/usr/bin/env bun
// alarmInfo passthrough. The platform hands alarm() an AlarmInvocationInfo
// ({ isRetry, retryCount, scheduledTime }) and retries a failed alarm up to
// six times — but agent-core's handlers are zero-arg and Nimbus's were too,
// so no object could tell how close the platform was to abandoning its
// schedule. The dispatcher forwards the info to every handler it runs.

import assert from 'node:assert/strict';
import { timers, TIMER_REASONS_KEY } from '../../packages/fabric/src/timers.ts';

function createCtx() {
  const kv = new Map();
  return {
    kv,
    storage: {
      async get(key) { return kv.get(key); },
      async put(key, value) { kv.set(key, value); },
      async delete(key) { return kv.delete(key); },
      setAlarm() {},
    },
  };
}

// The info the platform delivered reaches the handler.
{
  const ctx = createCtx();
  const host = {};
  await timers(host, ctx).schedule('sweep', 0);
  let seen;
  await timers(host, ctx).dispatch(
    { sweep: (now, info) => { seen = { now, info }; } },
    undefined,
    { isRetry: true, retryCount: 2, scheduledTime: 123 },
  );
  assert.deepEqual(seen.info, { isRetry: true, retryCount: 2, scheduledTime: 123 },
    'a handler can see the platform is retrying — and how close to abandonment');
}

// Without info (older runtimes, tests), the handler sees undefined.
{
  const ctx = createCtx();
  const host = {};
  await timers(host, ctx).schedule('sweep', 0);
  let seen = 'untouched';
  await timers(host, ctx).dispatch({ sweep: (_now, info) => { seen = info; } });
  assert.equal(seen, undefined);
  assert.equal(ctx.kv.has(TIMER_REASONS_KEY), false, 'a drained map still clears');
}

console.log('ok - fabric-timers-alarm-info (passthrough, absent-info undefined)');
