#!/usr/bin/env bun
// Deployment readiness is a terminal round trip AND confirmed destruction.
// A healthy /new, an HTTP 200 shell, or a rejected WebSocket is not ready.
import assert from 'node:assert/strict';
import { waitForTarget } from '../behavioral/_deploy-target.mjs';

const failures = [];
for (const mode of ['ready', 'upgrade-503', 'wrong-command-output', 'delete-500', 'delete-html', 'delete-invalid-result']) {
  const events = [];
  let minted = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      assert.equal(request.headers.get('Authorization'), 'Bearer readiness-token');
      const url = new URL(request.url);
      if (url.pathname === '/new' && request.method === 'POST') {
        const sid = `ready-session-${++minted}`;
        events.push({ stage: 'mint', sid });
        return new Response(null, { status: 302, headers: { Location: `/s/${sid}/` } });
      }
      if (url.pathname.endsWith('/ws')) {
        const sid = url.pathname.split('/')[2];
        events.push({ stage: 'upgrade', sid });
        if (mode === 'upgrade-503') return Response.json({ code: 'E_NIMBUS_DO_OVERLOADED' }, { status: 503 });
        if (server.upgrade(request, { data: { sid } })) return;
        throw new Error('expected a terminal WebSocket upgrade');
      }
      if (request.method === 'DELETE') {
        const sid = url.pathname.split('/')[2];
        events.push({ stage: 'delete', sid });
        if (mode === 'delete-500') return Response.json({ ok: false }, { status: 500 });
        if (mode === 'delete-html') return new Response('<title>session shell</title>', { headers: { 'Content-Type': 'text/html' } });
        return Response.json({ ok: true, result: {
          ok: mode !== 'delete-invalid-result', killed: 0, destroyedAt: Date.now(), reason: 'target-readiness',
        } });
      }
      throw new Error(`unexpected readiness request: ${request.method} ${url.pathname}`);
    },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ type: 'output', data: 'user@nimbus:~$ ' })); },
      message(ws, wire) {
        const message = JSON.parse(String(wire));
        assert.equal(message.type, 'input');
        events.push({ stage: 'command', sid: ws.data.sid, command: message.data });
        const output = mode === 'wrong-command-output' ? '__NIMBUS_READY_0__' : '__NIMBUS_READY_42__';
        ws.send(JSON.stringify({ type: 'output', data: `${output}\r\nuser@nimbus:~$ ` }));
      },
    },
  });
  try {
    let error = null;
    try { await waitForTarget(server.url.origin, 'readiness-token', mode === 'ready' ? 2_000 : 300); }
    catch (e) { error = e; }
    const stages = events.map((e) => e.stage);
    if (mode === 'ready') {
      if (error) failures.push(`${mode}: ${error.message}`);
      if (stages.join(',') !== 'mint,upgrade,command,delete') failures.push(`${mode}: missing full readiness round trip: ${stages}`);
      const command = events.find((e) => e.stage === 'command')?.command ?? '';
      if (!command.includes('$((6*7))')) failures.push(`${mode}: command must compute output, not accept its echoed source`);
    } else if (!error) {
      failures.push(`${mode}: declared ready instead of rejecting an unconfirmed round trip`);
    }
    if (!stages.includes('delete')) failures.push(`${mode}: minted session was not cleaned up`);
    if (!stages.includes('upgrade')) failures.push(`${mode}: no terminal upgrade was attempted`);
    if (['delete-500', 'delete-html', 'delete-invalid-result'].includes(mode) && error) {
      if (!/DELETE|destroy|cleanup/i.test(error.message)) failures.push(`${mode}: error did not identify failed cleanup`);
      if (!/ready-session-1/.test(error.message)) failures.push(`${mode}: failed cleanup did not name its session`);
      if (minted !== 1) failures.push(`${mode}: minted another session while its predecessor remained unconfirmed`);
    }
  } finally {
    server.stop(true);
  }
}
assert.deepEqual(failures, [], 'readiness requires an authenticated terminal, command output and confirmed DELETE');
console.log('deploy-target-readiness: ok');
