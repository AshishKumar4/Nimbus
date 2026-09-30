#!/usr/bin/env bun
// A task that stays pending for a whole command (here a background sleep)
// must not be subscribed to again every time the scheduler wakes. The
// scheduler used to race the whole pending set on each wake, so each of the
// loop's forks below left one more reaction on the sleep's task until it
// settled: 300 iterations attached 1,205 handlers, growing with the length of
// the command rather than with what it held. Each task now wakes the
// scheduler once, when it settles.
//
// A reaction on a pending promise is not a heap object bun:jsc counts, and
// the runner yields to no timer while the loop runs, so this counts the
// subscriptions the scheduler makes rather than sampling the heap.
import assert from 'node:assert/strict';
import { runScript } from './lib/bash-preamble.mjs';

const ITERATIONS = 300;
const race = Promise.race.bind(Promise);
let subscribed = 0;
Promise.race = (values) => {
  const list = [...values];
  subscribed += list.length;
  return race(list);
};
let r;
try {
  r = await runScript(`sleep 2 & i=0; while [ $i -lt ${ITERATIONS} ]; do x=$(echo $i); i=$((i+1)); done; wait; echo "$x"`);
} finally {
  Promise.race = race;
}

assert.equal(r.stdout, `${ITERATIONS - 1}\n`, JSON.stringify({ stdout: r.stdout, stderr: r.stderr, state: r.state }));
assert.ok(subscribed < ITERATIONS / 10, `the scheduler subscribed to pending tasks ${subscribed} times across ${ITERATIONS} wakes`);
console.log(`bash-scheduler-parked-task: ${ITERATIONS} wakes beside a pending task, ${subscribed} race subscriptions`);
