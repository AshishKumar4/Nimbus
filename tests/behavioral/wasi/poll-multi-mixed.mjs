#!/usr/bin/env bun
// wasi/poll-multi-mixed — WASI socket and polling support B8 — concurrent-ready drain.
//
// Spec: poll_oneoff with N subscriptions blocks until at least one fires;
// the impl SHOULD drain all currently-ready subscriptions in one call
// rather than returning the first one and forcing N-1 follow-up calls.
//
// Fixture: 3 subscriptions in one poll_oneoff:
//   sub[0]: CLOCK MONOTONIC +10s (slow timer, won't fire in test budget)
//   sub[1]: FD_READ on a regular file (always-ready synchronously)
//   sub[2]: CLOCK MONOTONIC +50ms (fast timer)
// Asserts: nev >= 1 AND at least one returned event has type=FD_READ (1).
// The always-ready file should short-circuit the race; the +50ms timer
// MAY also fire concurrently (and that's still PASS); the +10s timer's
// setTimeout is canceled after the race resolves.
//
// Runtime-behavioral: validates the multi-subscription drain logic
// (Promise.race winner + microtask-sentinel probe of others).

import { openWasiProbe, tailLines, trimmedLines } from './_harness.mjs';

const probe = await openWasiProbe('wasi/poll-multi-mixed', { dir: '/home/user/sb', fixture: 'poll-multi-mixed', as: 'pm.wasm' });
const { t } = probe;
try {
  const r = await t.run('wasm-runner pm.wasm', 30_000);
  const tail = tailLines(r.output, 6);
  const lines = trimmedLines(tail);
  const ok = lines.some(s => s === '1');

  probe.report([['poll_oneoff(clock+file+clock) drains always-ready file event', ok]], { tail, ok });
} finally {
  await probe.close();
}
process.exit(probe.exitCode());
