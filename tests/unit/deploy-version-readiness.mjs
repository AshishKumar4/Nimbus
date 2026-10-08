#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { waitForTarget } from '../behavioral/_deploy-target.mjs';

const uploaded = 'uploaded-version';
const header = 'x-nimbus-probe-version';
const cycles = 64;
const failures = [];

for (const mode of ['ready', 'mint-mismatch', 'upgrade-mismatch', 'delete-mismatch', 'transient-500', 'bound']) {
  let minted = 0;
  let upgrades = 0;
  let commands = 0;
  let saw500 = false;
  const destroyed = new Set();
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      assert.equal(request.headers.get('authorization'), 'Bearer readiness-token');
      const path = new URL(request.url).pathname;
      if (path === '/new') {
        const sid = `session-${++minted}`;
        const stale = mode === 'bound' || (mode === 'mint-mismatch' && minted === 1);
        return new Response(null, { status: 302, headers: { Location: `/s/${sid}/`, [header]: stale ? 'previous-version' : uploaded } });
      }
      if (path.endsWith('/ws')) {
        upgrades++;
        const stale = mode === 'upgrade-mismatch' && upgrades === 1;
        if (server.upgrade(request, { headers: { [header]: stale ? 'previous-version' : uploaded } })) return;
        throw new Error('terminal did not upgrade');
      }
      if (request.method === 'DELETE') {
        const sid = path.split('/')[2];
        if (mode === 'transient-500' && sid === 'session-4' && !saw500) {
          saw500 = true;
          return new Response('internal error; reference fixture', { status: 500, headers: { [header]: uploaded } });
        }
        destroyed.add(sid);
        const stale = mode === 'delete-mismatch' && sid === 'session-1';
        return Response.json({ ok: true, result: { ok: true, killed: 0, destroyedAt: Date.now(), reason: 'target-readiness' } }, { headers: { [header]: stale ? 'previous-version' : uploaded } });
      }
      throw new Error(`unexpected ${request.method} ${path}`);
    },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ type: 'output', data: 'user@nimbus:~$ ' })); },
      message(ws, wire) {
        const message = JSON.parse(String(wire));
        assert.equal(message.type, 'input');
        commands++;
        ws.send(JSON.stringify({ type: 'output', data: '__NIMBUS_READY_42__\r\nuser@nimbus:~$ ' }));
      },
    },
  });
  try {
    let error;
    try { await waitForTarget(server.url.origin, 'readiness-token', mode === 'bound' ? 250 : 15_000, uploaded); }
    catch (caught) { error = caught; }
    if (mode === 'bound') {
      assert.ok(error, 'an old version can never declare the uploaded version ready');
      assert.equal(error.exitCode, 2, 'exhausting readiness is NOT GRADED, never a red code verdict');
      assert.match(error.message, /version|uploaded|previous/i);
    } else {
      assert.equal(error, undefined, `${mode}: ${error?.message}`);
      const expected = cycles + (mode === 'ready' ? 0 : mode === 'transient-500' ? 4 : 1);
      assert.equal(minted, expected, 'only K consecutive complete, version-matched healthy cycles declare readiness');
      if (mode === 'transient-500') assert.ok(saw500, 'a transient session-object 500 resets the consecutive successes');
      if (mode === 'mint-mismatch') assert.equal(upgrades, cycles, 'a receipt-mismatched mint is not counted or upgraded');
      if (mode === 'upgrade-mismatch') assert.equal(commands, cycles, 'an old version\'s upgrade cannot count as healthy');
    }
    assert.equal(destroyed.size, minted, 'every readiness session is confirmed destroyed, including failed cycles');
    console.log(`PASS ${mode}: ${minted} sessions, ${commands} commands, ${destroyed.size} destroyed`);
  } catch (error) {
    failures.push(`${mode}: ${error.message}`);
  } finally {
    server.stop(true);
  }
}
assert.deepEqual(failures, []);
console.log('deploy-version-readiness: PASS');
