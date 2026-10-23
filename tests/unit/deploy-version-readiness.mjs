#!/usr/bin/env bun
// @tier slow — 64-cycle health and version cases; CI 37.65 s wall (2026-10-08).
import assert from 'node:assert/strict';
import { waitForTarget, waitForVersion } from '../behavioral/_deploy-target.mjs';
import { VERSION_HEADER } from '../behavioral/_session-transport.mjs';

const uploaded = 'uploaded-version';
const header = VERSION_HEADER;
const cycles = 64;
const failures = [];

// 'cut': the second session's upgrade is refused (500); every later one is
// never answered, so the deadline cuts the last cycle's connect short. What
// readiness reports is the refusal, a failure of a whole cycle, with a tally.
for (const mode of ['ready', 'mint-mismatch', 'upgrade-mismatch', 'delete-mismatch', 'transient-500', 'bound', 'cut']) {
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
        if (mode === 'cut' && upgrades === 2) return new Response('internal error; reference fixture', { status: 500 });
        if (mode === 'cut' && upgrades > 2) return new Promise(() => {});
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
      open(ws) {
        ws.send(JSON.stringify({ type: 'output', data: 'user@nimbus:~$ ' }));
        ws.send(JSON.stringify({ type: 'shell-integration', event: 'prompt' }));
      },
      message(ws, wire) {
        const message = JSON.parse(String(wire));
        assert.equal(message.type, 'input');
        commands++;
        ws.send(JSON.stringify({ type: 'output', data: '__NIMBUS_READY_42__\r\nuser@nimbus:~$ ' }));
        ws.send(JSON.stringify({ type: 'shell-integration', event: 'end', submissionId: message.submissionId, exitCode: 0 }));
      },
    },
  });
  try {
    let error;
    try { await waitForTarget(server.url.origin, 'readiness-token', mode === 'bound' ? 250 : mode === 'cut' ? 4_000 : 15_000, uploaded); }
    catch (caught) { error = caught; }
    if (mode === 'cut') {
      assert.ok(error, 'a target that refuses and then never answers is not ready');
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /\(2 of \d+ cycles failed, the longest run of healthy cycles was 1\)/, 'it counts the cycles');
      assert.match(error.message, /did not open: socket error: .*(101|500)/, `it names the refusal, a whole cycle's failure, not the cut one: ${error.message}`);
    } else if (mode === 'bound') {
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
// A deployment readiness cannot open a session on (the hosted demo): its
// stamped answers count only from the uploaded version. The old version
// stamps nothing at all, as the version before this one did.
for (const mode of ['old-first', 'old-mid-streak', 'paced', 'never-new']) {
  let answers = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      assert.equal(request.method, 'POST');
      assert.equal(new URL(request.url).pathname, '/api/nimbus/v1/sandboxes/nimbus-readiness/rpc');
      assert.equal(request.headers.get('authorization'), null, 'readiness needs no credential');
      answers++;
      const old = mode === 'never-new' || (mode === 'old-first' && answers === 1) || (mode === 'old-mid-streak' && answers === 10);
      return Response.json({ ok: false, code: 'E_AUTH_MISSING' }, { status: 401, headers: old ? {} : { [header]: uploaded } });
    },
  });
  try {
    const floorMs = mode === 'paced' ? 20 : 1;
    const started = Date.now();
    let error;
    try { await waitForVersion(server.url.origin, uploaded, { timeoutMs: mode === 'never-new' ? 300 : 15_000, floorMs }); }
    catch (caught) { error = caught; }
    if (mode === 'never-new') {
      assert.ok(error, 'an old version can never declare the uploaded version ready');
      assert.equal(error.exitCode, 2, 'exhausting readiness is NOT GRADED');
      assert.match(error.message, /answered version null, expected uploaded version uploaded-version/);
    } else {
      assert.equal(error, undefined, `${mode}: ${error?.message}`);
      const expected = cycles + (mode === 'old-first' ? 1 : mode === 'old-mid-streak' ? 10 : 0);
      assert.equal(answers, expected, `${mode}: only ${cycles} consecutive answers from the uploaded version declare readiness`);
      if (mode === 'paced') assert.ok(Date.now() - started >= (cycles - 1) * floorMs, 'each answer is paced to the cycle floor');
    }
    console.log(`PASS stamped ${mode}: ${answers} answers`);
  } catch (error) {
    failures.push(`stamped ${mode}: ${error.message}`);
  } finally {
    server.stop(true);
  }
}

assert.deepEqual(failures, []);
console.log('deploy-version-readiness: PASS');
