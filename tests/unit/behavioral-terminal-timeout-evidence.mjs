#!/usr/bin/env bun
// A wait that times out says what the session's launches were waiting on and
// which processes it held, read from the session before the probe deletes it:
// the only evidence a command that started and never finished leaves.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Terminal } from '../behavioral/_driver.mjs';

const asked = [];
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    asked.push(pathname);
    if (pathname === '/s/stalled/api/_diag/session') return Response.json({ cwd: '/home/user', launch: { launches: [{ pid: 1000004, stage: 'admission', ms: 59_000 }], ledger: { waiters: 3 } } });
    if (pathname === '/s/stalled/api/processes') return Response.json([{ pid: 1000004, command: 'node', state: 'running' }]);
    return new Response('not found', { status: 404 });
  },
});
try {
  const terminal = new Terminal('stalled', { base: `http://127.0.0.1:${server.port}`, wsOptions: {} });
  terminal.ws = new EventEmitter();
  const error = await terminal.waitFor(() => false, 50, 'submitted shell batch').catch((e) => e);
  assert.ok(error instanceof Error);
  assert.ok(error.message.startsWith('waitFor(submitted shell batch) timeout after 50ms'), error.message);
  assert.ok(error.message.includes(JSON.stringify({ launches: [{ pid: 1000004, stage: 'admission', ms: 59_000 }], ledger: { waiters: 3 } })), error.message);
  assert.ok(error.message.includes(JSON.stringify([{ pid: 1000004, command: 'node', state: 'running' }])), error.message);
  assert.deepEqual(asked.sort(), ['/s/stalled/api/_diag/session', '/s/stalled/api/processes']);
  assert.equal(terminal.ws.listenerCount('message'), 0, 'the timed-out wait released its listeners');

  // A session that cannot answer still fails the wait, naming why it could not say more.
  const unknown = new Terminal('gone', { base: `http://127.0.0.1:${server.port}`, wsOptions: {} });
  unknown.ws = new EventEmitter();
  const failed = await unknown.waitFor(() => false, 50, 'prompt').catch((e) => e);
  assert.ok(failed.message.includes('/api/_diag/session answered 404'), failed.message);
} finally {
  server.stop(true);
}
console.log('behavioral-terminal-timeout-evidence: a timed-out wait carries the session\'s launches and processes');
