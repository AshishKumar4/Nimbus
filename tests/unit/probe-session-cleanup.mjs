#!/usr/bin/env bun
// probe-session-cleanup — the driver DELETEs every session it minted when the probe process ends.
// 'exit' listeners run synchronously, so an async DELETE there would silently delete nothing.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { retryAfterMs, sessionOutcomes } from '../behavioral/_ledger.mjs';

const DRIVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'behavioral', '_driver.mjs');
const SCRATCH = mkdtempSync(join(tmpdir(), 'probe-session-cleanup-'));

let minted = 0;
let deletes = [];
let deleteStatus = 200;
let deleteShape = 'destroy';
/** Statuses for the next DELETEs, in order, before deleteStatus applies; a 503 carries deleteRetryAfter (null: no header). */
let deletePlan = [];
let deleteRetryAfter = '0';
let deleteTimes = [];
const target = Bun.serve({
  port: 0,
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === 'POST' && pathname === '/new') {
      // Production's gate: without a credential, POST /new asks for an interactive login.
      if (!req.headers.get('authorization')) return Response.json({ code: 'E_DEMO_LOGIN_REQUIRED' }, { status: 401 });
      return new Response(null, { status: 302, headers: { Location: `/s/fixture-${++minted}/` } });
    }
    if (req.method === 'POST' && pathname === '/api/demo/anon-session') {
      const sid = `anon-${++minted}`;
      return Response.json({ sessionId: sid, wsUrl: `/s/${sid}/ws?nimbus_token=pinned-${sid}` });
    }
    const m = pathname.match(/^\/s\/([^/]+)\/$/);
    if (req.method === 'DELETE' && m) {
      deletes.push(`${m[1]} ${req.headers.get('authorization')}`);
      deleteTimes.push(Date.now());
      const planned = deletePlan.shift();
      if (planned === 503) {
        return Response.json({ ok: false, error: 'Durable Object is overloaded.', code: 'E_NIMBUS_DO_OVERLOADED' }, { status: 503, headers: deleteRetryAfter === null ? {} : { 'Retry-After': deleteRetryAfter } });
      }
      if (planned !== undefined) return Response.json({ ok: false, error: 'boom' }, { status: planned });
      if (deleteShape === 'html') return new Response('<html>session shell</html>', { status: deleteStatus, headers: { 'content-type': 'text/html' } });
      if (deleteShape === 'broken-json') return new Response('{"ok":', { status: deleteStatus, headers: { 'content-type': 'application/json' } });
      if (deleteShape === 'ok-only') return Response.json({ ok: true }, { status: deleteStatus });
      return Response.json({ ok: true, result: { ok: true, killed: 0, destroyedAt: 1234, reason: null } }, { status: deleteStatus });
    }
    return new Response('not found', { status: 404 });
  },
});

/** Run `body` as a probe process that imports the driver: its exit, the DELETEs it caused, its ledger. */
async function probe(name, body, { status = 200, token = 'probe-token', shape = 'destroy', plan = [], retryAfter = '0' } = {}) {
  const file = join(SCRATCH, `${name}.mjs`);
  const ledger = join(SCRATCH, `${name}.jsonl`);
  writeFileSync(file, `import { mintSession, deleteSession, sleep } from ${JSON.stringify(DRIVER)};\n${body}\n`);
  minted = 0;
  deletes = [];
  deleteStatus = status;
  deleteShape = shape;
  deletePlan = [...plan];
  deleteRetryAfter = retryAfter;
  deleteTimes = [];
  const child = Bun.spawn([process.execPath, file], {
    env: { ...process.env, BASE: `http://127.0.0.1:${target.port}`, NIMBUS_PROBE_TOKEN: token, NIMBUS_PROBE_LEDGER: ledger },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const text = existsSync(ledger) ? readFileSync(ledger, 'utf8') : '';
  const events = text ? text.trim().split('\n').map((l) => JSON.parse(l)).map((e) => `${e.event} ${e.sid} ${e.status}`) : [];
  return { code, signal: child.signalCode, deletes, events, outcomes: sessionOutcomes(text), text, stderr };
}

// [1] An early exit without deleteSession: the hook DELETEs with the probe's credential; the exit code stands.
{
  const r = await probe('early-exit', 'await mintSession();\nprocess.exit(3);');
  assert.equal(r.code, 3);
  assert.deepEqual(r.deletes, ['fixture-1 Bearer probe-token']);
  assert.deepEqual(r.events, ['mint fixture-1 302', 'exit-delete fixture-1 200']);
  console.log('  [1] an early process.exit still DELETEs the session');
}

// [2] An uncaught error and a SIGTERM end the probe the same way.
{
  const thrown = await probe('throws', "await mintSession();\nthrow new Error('probe failed');");
  assert.equal(thrown.code, 1);
  assert.deepEqual(thrown.deletes, ['fixture-1 Bearer probe-token']);
  const term = await probe('sigterm', "await mintSession();\nprocess.kill(process.pid, 'SIGTERM');\nawait sleep(5_000);");
  assert.deepEqual(term.deletes, ['fixture-1 Bearer probe-token']);
  console.log('  [2] an uncaught error or SIGTERM still DELETEs the session');
}

// [3] deleteSession releases a session, so the hook sends no second DELETE; a failed one is retried.
{
  const done = await probe('explicit', 'const a = await mintSession();\nawait mintSession();\nawait deleteSession(a);');
  assert.deepEqual(done.deletes, ['fixture-1 Bearer probe-token', 'fixture-2 Bearer probe-token']);
  assert.deepEqual(done.events.slice(2), ['delete fixture-1 200', 'exit-delete fixture-2 200']);
  const failed = await probe('explicit-fails', 'await deleteSession(await mintSession());', { status: 500 });
  assert.deepEqual(failed.events.slice(1), ['delete fixture-1 500', 'exit-delete fixture-1 500']);
  console.log('  [3] deleteSession releases a session; a failed DELETE is retried at exit');
}

// [4] SIGKILL is the exit no hook sees: the ledger keeps a mint with no DELETE, which run-all reports.
{
  const r = await probe('sigkill', "await mintSession();\nprocess.kill(process.pid, 'SIGKILL');\nawait sleep(5_000);");
  assert.equal(r.signal, 'SIGKILL');
  assert.deepEqual(r.deletes, []);
  assert.deepEqual(r.events, ['mint fixture-1 302']);
  assert.deepEqual(r.outcomes.leaks.map(([sid]) => sid), ['fixture-1'], 'run-all names it a leak');
  console.log('  [4] a SIGKILLed probe leaves an undeleted mint in the ledger');
}

// [5] An anonymous demo session (no credential, production's gate) cannot be DELETEd: the
// endpoint answers 401 by design and the demo's TTL reaps it. It is reported as such, not a leak.
{
  const r = await probe('anon', 'await mintSession();', { status: 401, token: '' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.deletes, ['anon-1 Bearer pinned-anon-1']);
  assert.deepEqual(r.outcomes.leaks, [], 'an anonymous session the TTL reaps is not a leak');
  assert.deepEqual(r.outcomes.ttlReaped.map(([sid]) => sid), ['anon-1']);
  // One that did get a 2xx DELETE counts as deleted.
  const deleted = await probe('anon-deleted', 'await mintSession();', { status: 200, token: '' });
  assert.deepEqual(deleted.outcomes.ttlReaped, []);
  assert.equal(deleted.outcomes.deleted, 1);
  console.log('  [5] an anonymous session is TTL-reaped, not leaked');
}

// [6] Only the destroy result releases a session. A 200 carrying the session
// shell's HTML (a router that ignores the method), broken JSON or a bare
// `{ ok: true }` destroyed nothing: deleteSession reports it unconfirmed, the
// exit hook tries again, and run-all names the session a leak.
for (const shape of ['html', 'broken-json', 'ok-only']) {
  const r = await probe(`false-success-${shape}`, 'const r = await deleteSession(await mintSession());\nif (r.ok) throw new Error("false deletion proof");', { shape });
  assert.equal(r.code, 0, `${shape}: deleteSession reports the DELETE unconfirmed`);
  assert.deepEqual(r.deletes, ['fixture-1 Bearer probe-token', 'fixture-1 Bearer probe-token'], `${shape}: the exit hook retries it`);
  assert.equal(r.outcomes.deleted, 0);
  assert.deepEqual(r.outcomes.leaks.map(([sid]) => sid), ['fixture-1']);
  const deletes = r.text.trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.event !== 'mint');
  assert.deepEqual(deletes.map((e) => [e.event, e.status, e.confirmed]), [['delete', 200, false], ['exit-delete', 200, false]]);
}
const historical = [{ event: 'mint', sid: 'historical' }, { event: 'delete', sid: 'historical', status: 200 }]
  .map((e) => JSON.stringify(e)).join('\n');
assert.equal(sessionOutcomes(historical).deleted, 0, 'a bare 200 row without confirmation proves no deletion');
console.log('  [6] only the destroy result confirms a deletion');

// [7] A failing probe names every session it minted, with its mint time, so
// a session that reset can be found by its session in Workers Logs; one that
// passes names none.
{
  const before = Date.now();
  const failed = await probe('names-sessions', "const a = await mintSession();\nawait mintSession();\nawait deleteSession(a);\nthrow new Error('probe failed');");
  assert.equal(failed.code, 1);
  const named = [...failed.stderr.matchAll(/^  (fixture-\d+)  minted (\S+)(  \(deleted by the probe\))?$/gm)];
  assert.deepEqual(named.map((m) => [m[1], Boolean(m[3])]), [['fixture-1', true], ['fixture-2', false]], failed.stderr);
  for (const m of named) assert.ok(Date.parse(m[2]) >= before - 1000 && Date.parse(m[2]) <= Date.now(), `a mint time: ${m[2]}`);
  assert.match(failed.stderr, /^sessions this probe minted on http:\/\/127\.0\.0\.1:\d+ \(exit 1\):$/m);
  // The run's ledger carries the same times, for a run kept with run-all's --ledger.
  const mints = failed.text.trim().split('\n').map((line) => JSON.parse(line)).filter((e) => e.event === 'mint');
  assert.deepEqual(mints.map((e) => [e.sid, e.at]), named.map((m) => [m[1], m[2]]));
  const passed = await probe('names-none', 'await mintSession();');
  assert.equal(passed.code, 0);
  assert.doesNotMatch(passed.stderr, /sessions this probe minted/);
  console.log('  [7] a failing probe names the sessions it minted, with their mint times');
}

// [8] A 503 (a session too busy to admit the destroy: it never ran) or a
// failed request is tried again at exit, after the answer's Retry-After,
// at most 4 times within 30 s; a session is a leak only if every try fails.
// Measured on staging: a session still installing answered its one DELETE
// 503 and was counted a leak while it lived.
{
  const busy = await probe('busy-then-destroyed', 'await mintSession();', { plan: [503] });
  assert.deepEqual(busy.deletes, ['fixture-1 Bearer probe-token', 'fixture-1 Bearer probe-token']);
  assert.deepEqual(busy.events, ['mint fixture-1 302', 'exit-delete fixture-1 200']);
  assert.equal(busy.outcomes.deleted, 1);
  assert.deepEqual(busy.outcomes.leaks, []);
  assert.equal(JSON.parse(busy.text.trim().split('\n').at(-1)).attempts, 2, 'the ledger records the tries');

  const waited = await probe('busy-retry-after', 'await mintSession();', { plan: [503], retryAfter: '1' });
  assert.equal(waited.events.at(-1), 'exit-delete fixture-1 200');
  assert.ok(deleteTimes[1] - deleteTimes[0] >= 900, `Retry-After: 1 is waited out (${deleteTimes[1] - deleteTimes[0]} ms)`);

  // No Retry-After at all: the 1 s default, not an immediate retry (a missing
  // header once read as 0 and spent every try at once).
  const bare = await probe('busy-no-retry-after', 'await mintSession();', { plan: [503, 503], retryAfter: null });
  assert.equal(bare.events.at(-1), 'exit-delete fixture-1 200');
  assert.equal(deleteTimes.length, 3);
  for (let i = 1; i < deleteTimes.length; i++) {
    assert.ok(deleteTimes[i] - deleteTimes[i - 1] >= 900, `no Retry-After waits the 1 s default (try ${i + 1} after ${deleteTimes[i] - deleteTimes[i - 1]} ms)`);
  }

  // An HTTP-date is waited out until that moment (it has whole seconds, so 1-2 s from now).
  const dated = await probe('busy-retry-after-date', 'await mintSession();', { plan: [503], retryAfter: new Date(Date.now() + 2000).toUTCString() });
  assert.equal(dated.events.at(-1), 'exit-delete fixture-1 200');
  const datedGap = deleteTimes[1] - deleteTimes[0];
  assert.ok(datedGap >= 700 && datedGap < 4000, `Retry-After as an HTTP-date is waited out (${datedGap} ms)`);

  const stuck = await probe('busy-throughout', 'await mintSession();', { plan: [503, 503, 503, 503, 503, 503] });
  assert.equal(stuck.deletes.length, 4, 'at most 4 tries');
  assert.deepEqual(stuck.events, ['mint fixture-1 302', 'exit-delete fixture-1 503']);
  assert.deepEqual(stuck.outcomes.leaks.map(([sid]) => sid), ['fixture-1'], 'every try failed: a leak');

  const refused = await probe('refused', 'await mintSession();', { plan: [500] });
  assert.equal(refused.deletes.length, 1, 'another failure is the verdict, not retried');
  // Retry-After itself: delay-seconds, or an HTTP-date from now; nothing else.
  const now = Date.parse('2026-10-08T00:00:00Z');
  assert.equal(retryAfterMs('5', now), 5000);
  assert.equal(retryAfterMs(' 0 ', now), 0);
  assert.equal(retryAfterMs('Thu, 08 Oct 2026 00:00:03 GMT', now), 3000);
  assert.equal(retryAfterMs('Wed, 07 Oct 2026 23:59:00 GMT', now), 0, 'a date past is no wait');
  for (const bad of [null, '', '  ', '1.5', '-1', 'soon']) assert.equal(retryAfterMs(bad, now), null, `ignored: ${JSON.stringify(bad)}`);
  console.log('  [8] a 503 at exit is tried again, after Retry-After, at most 4 times; a leak only if every try fails');
}

target.stop(true);
rmSync(SCRATCH, { recursive: true, force: true });
console.log('probe-session-cleanup: all tests passed');
