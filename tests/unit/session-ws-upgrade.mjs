#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { classifyWsUpgrade } from '../../packages/worker/src/session/init-phases.ts';

function makeSession() {
  return {
    _b4Phase: 'hydrated',
    shell: {},
    terminal: {},
    kernel: {},
  };
}

{
  const sockets = [
    { readyState: WebSocket.OPEN, deserializeAttachment: () => ({ kind: 'fs-watch' }) },
    { readyState: WebSocket.CLOSED, deserializeAttachment: () => ({ kind: 'shell' }) },
    { readyState: WebSocket.OPEN, deserializeAttachment: () => { throw new Error('bad attachment'); } },
  ];
  assert.equal(classifyWsUpgrade(makeSession(), sockets), 'warm-join');
  console.log('  [1] a headless hydrated session with no open shell socket warm-joins');
}

{
  const sockets = [
    { readyState: WebSocket.OPEN, deserializeAttachment: () => ({ kind: 'shell' }) },
  ];
  assert.equal(classifyWsUpgrade(makeSession(), sockets), 'conflict');
  console.log('  [2] an open shell socket preserves the two-tab conflict');
}

{
  const incomplete = makeSession();
  incomplete.terminal = null;
  assert.equal(classifyWsUpgrade(incomplete, []), 'conflict');

  const cold = makeSession();
  cold.shell = null;
  assert.equal(classifyWsUpgrade(cold, []), 'cold');
  console.log('  [3] incomplete live state conflicts while a shell-less session cold-starts');
}

console.log('session-ws-upgrade OK: /ws decisions follow the attached shell socket');
