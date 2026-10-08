#!/usr/bin/env bun
// Pids never repeat across a session's incarnations. Each incarnation mints
// from its generation's base (generation * PID_GEN_STRIDE); one that mints
// into the next stride raises the persisted generation to it, so the next
// incarnation's base lies past every pid it minted. Red before: an
// incarnation that minted a million pids reached the next one's range, and
// a pid could name two processes (a write log's row, its cursors) at once.

import assert from 'node:assert/strict';
import { PID_GEN_STRIDE, ProcessTable } from '../../packages/core/src/runtime/process-table.ts';
import { adoptGeneration, generation, raiseGeneration } from '../../packages/fabric/src/generation.ts';

const stored = new Map();
const storage = { get: async (key) => stored.get(key), put: async (key, value) => { stored.set(key, value); } };

// Incarnation 2: its range is (2M, 3M].
const first = { storage };
stored.set('w9_isolate_gen', 1);
await adoptGeneration(first);
assert.equal(generation(first), 2);
const table = new ProcessTable();
const raised = [];
table.onPidStride((stride) => { raised.push(stride); void raiseGeneration(first, stride); });
// Near the end of its range (as if it had minted almost a million).
table.setPidBase(3 * PID_GEN_STRIDE - 3);
const pids = [];
for (let i = 0; i < 4; i++) pids.push(table.spawn('sh', ['sh'], '/').pid);
assert.deepEqual(raised, [3], `minting past the range raised nothing (pids ${pids})`);
await new Promise((resolve) => setTimeout(resolve, 0));

// The next incarnation starts past every pid the last one minted.
const second = { storage };
await adoptGeneration(second);
const base = generation(second) * PID_GEN_STRIDE;
assert.ok(base >= Math.max(...pids), `the next base ${base} is not past the last pid ${Math.max(...pids)}`);

console.log('pid-stride-generation: ok');
