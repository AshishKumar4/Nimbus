#!/usr/bin/env bun

import assert from 'node:assert/strict';
import {
  SHELL_OWNER_LIVENESS_MS,
  closeStaleShellSockets,
  hasLiveShellOwner,
  noteShellSocketActivity,
  tagShellSocket,
} from '../../packages/worker/src/session/shell-socket.ts';

const NOW = 1_700_000_000_000;

function socket({ kind = 'shell', readyState = WebSocket.OPEN, seenAt, autoResponseAt } = {}) {
  let attachment = kind === null ? null : (seenAt === undefined ? { kind } : { kind, seenAt });
  return {
    readyState,
    autoResponseAt: autoResponseAt ?? null,
    closedWith: null,
    writes: 0,
    deserializeAttachment: () => attachment,
    serializeAttachment(next) { attachment = next; this.writes += 1; },
    close(code, reason) { this.closedWith = { code, reason }; this.readyState = WebSocket.CLOSING; },
  };
}

function ctxFor(sockets) {
  return {
    getWebSocketAutoResponseTimestamp: (ws) => sockets.find((s) => s === ws)?.autoResponseAt ?? null,
  };
}

{
  const ws = socket({ kind: null });
  tagShellSocket(ws, NOW);
  assert.equal(hasLiveShellOwner(ctxFor([ws]), [ws], NOW), true);
  assert.equal(hasLiveShellOwner(ctxFor([ws]), [ws], NOW + SHELL_OWNER_LIVENESS_MS), false);
  console.log('  [1] an accepted socket owns the terminal until its window runs out');
}

{
  const ws = socket({ seenAt: NOW });
  noteShellSocketActivity(ws, NOW + 1_000);
  assert.equal(ws.writes, 0, 'a stamp this fresh needs no rewrite');
  noteShellSocketActivity(ws, NOW + 20_000);
  assert.equal(ws.writes, 1, 'an aged stamp is rewritten once');
  assert.equal(hasLiveShellOwner(ctxFor([ws]), [ws], NOW + 100_000), true);
  console.log('  [2] inbound frames refresh the stamp without writing on every one');
}

{
  const other = socket({ kind: 'fs-watch', seenAt: NOW });
  noteShellSocketActivity(other, NOW + 60_000);
  assert.equal(other.writes, 0);
  assert.equal(hasLiveShellOwner(ctxFor([other]), [other], NOW), false);
  console.log('  [3] sockets of another kind are neither stamped nor owners');
}

{
  // Nothing on the far end since the tab died, so nothing refreshed it.
  const at = NOW + SHELL_OWNER_LIVENESS_MS + 30_000;
  const ghost = socket({ seenAt: NOW });
  const live = socket({ seenAt: at - 1_000 });
  const watcher = socket({ kind: 'fs-watch', seenAt: NOW });
  const closed = socket({ readyState: WebSocket.CLOSED, seenAt: NOW });
  const all = [ghost, live, watcher, closed];

  assert.equal(hasLiveShellOwner(ctxFor(all), all, at), true);
  closeStaleShellSockets(ctxFor(all), all, at);
  assert.equal(ghost.closedWith?.code, 1001);
  assert.equal(live.closedWith, null, 'the tab still holding the terminal keeps it');
  assert.equal(watcher.closedWith, null, 'a watcher socket is not the terminal');
  assert.equal(closed.closedWith, null, 'the runtime already dropped this one');
  console.log('  [4] a takeover closes only the sockets nobody is on');
}

{
  // An attachment outlives the deploy that wrote it, so treat it as input.
  const future = socket({ seenAt: NOW + 3_600_000 });
  assert.equal(hasLiveShellOwner(ctxFor([future]), [future], NOW), false);

  const garbage = socket({ seenAt: 'yesterday' });
  assert.equal(hasLiveShellOwner(ctxFor([garbage]), [garbage], NOW), false);

  const throwing = {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => { throw new Error('unreadable'); },
  };
  assert.equal(hasLiveShellOwner(ctxFor([throwing]), [throwing], NOW), false);
  console.log('  [5] an unusable attachment proves nothing');
}

{
  // A tab that only pings never wakes the object, so only the runtime's
  // own auto-response records that it is there.
  const at = NOW + SHELL_OWNER_LIVENESS_MS + 30_000;
  const pinger = socket({ seenAt: NOW, autoResponseAt: new Date(at - 2_000) });
  assert.equal(hasLiveShellOwner(ctxFor([pinger]), [pinger], at), true, 'the stamp is stale; only the ping says otherwise');
  const silent = socket({ seenAt: NOW });
  assert.equal(hasLiveShellOwner(ctxFor([silent]), [silent], at), false);

  const blind = { readyState: WebSocket.OPEN, deserializeAttachment: () => ({ kind: 'shell', seenAt: NOW }) };
  assert.equal(hasLiveShellOwner(undefined, [blind], NOW + 1_000), true, 'a host without the API still reads the stamp');
  console.log('  [6] the runtime auto-response counts as the peer speaking');
}

console.log('session-shell-socket OK: terminal ownership needs a peer, not an open socket');
