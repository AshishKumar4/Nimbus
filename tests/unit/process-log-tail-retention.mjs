#!/usr/bin/env bun
/**
 * ProcessLogStore.tail and read() select the same last-N-lines/bytes window,
 * and ProcessLogRetention's next()/due() agree on which pids have a deadline:
 * held pids without a reader, then persisted pids the store does not hold.
 */

import assert from 'node:assert/strict';
import { ProcessLogStore } from '../../packages/core/src/runtime/process-logs.ts';
import { ProcessLogRetention } from '../../packages/core/src/runtime/process-log-retention.ts';

{
  const store = new ProcessLogStore();
  for (const data of ['a\n', 'b\nc\n', 'partial', 'd\n']) store.append(7, 'stdout', data);
  const texts = (chunks) => chunks.map((c) => c.data);
  const cases = [
    [{}, ['a\n', 'b\nc\n', 'partial', 'd\n']],
    [{ lines: 0 }, []],
    [{ bytes: 0 }, []],
    [{ lines: 1 }, ['d\n']],
    [{ lines: 2 }, ['b\nc\n', 'partial', 'd\n']],
    [{ lines: 3 }, ['b\nc\n', 'partial', 'd\n']],
    [{ lines: 99 }, ['a\n', 'b\nc\n', 'partial', 'd\n']],
    [{ bytes: 2 }, ['d\n']],
    [{ bytes: 3 }, ['partial', 'd\n']],
    [{ lines: 1, bytes: 9 }, ['d\n']],
    [{ lines: 4, bytes: 9 }, ['partial', 'd\n']],
  ];
  for (const [opts, expected] of cases) {
    assert.deepEqual(texts(store.tail(7, opts)), expected, `tail ${JSON.stringify(opts)}`);
    assert.deepEqual(texts(store.read(7, opts).chunks), expected, `read ${JSON.stringify(opts)}`);
  }
  assert.deepEqual(store.tail(8, { lines: 1 }), []);
}

{
  let listed = 0;
  const persistedRows = [
    { pid: 1, exitAt: 100, lastActivity: 100 }, // also held: the held entry answers
    { pid: 2, exitAt: 50, lastActivity: 50 },
    { pid: 3, exitAt: null, lastActivity: 10 }, // orphan: lastActivity + 3 * age
    { pid: 4, exitAt: null, lastActivity: 10 }, // not gone: no deadline
  ];
  const retention = new ProcessLogRetention(() => {
    listed++;
    return persistedRows;
  });
  const held = new Map([
    [1, { exit: { at: 200 }, lastActivity: 200, subscribers: { size: 0 } }],
    [5, { exit: { at: 20 }, lastActivity: 20, subscribers: { size: 1 } }], // a reader holds it
    [6, { exit: null, lastActivity: 5, subscribers: { size: 0 } }],
  ]);
  const isOrphan = (pid) => pid === 3 || pid === 6;
  const age = 100;
  assert.equal(retention.next(held, age, isOrphan), 150, 'pid 2: 50 + 100');
  assert.deepEqual(retention.due(held, 149, age, isOrphan), []);
  assert.deepEqual(retention.due(held, 300, age, isOrphan).sort(), [1, 2]);
  // pid 1 is still held, so it still answers; due persisted pids left the set.
  assert.equal(retention.next(held, age, isOrphan), 300);
  assert.equal(retention.next(new Map(), age, isOrphan), 310, 'pid 3: 10 + 3 * 100');
  assert.deepEqual(retention.due(held, 400, age, isOrphan).sort(), [1, 3, 6]);
  assert.equal(retention.next(new Map(), age, isOrphan), null, 'nothing persisted remains with a deadline');
  assert.equal(listed, 1, 'the persisted rows are listed once');

  const none = new ProcessLogRetention(() => null);
  assert.equal(none.next(new Map(), age), null);
  assert.deepEqual(none.due(new Map(), 1e9, age), []);
}

console.log('process-log-tail-retention: ok');
