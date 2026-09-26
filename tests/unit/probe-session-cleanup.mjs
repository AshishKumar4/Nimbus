#!/usr/bin/env bun
// probe-session-cleanup — the driver DELETEs every session it minted when the probe process ends.
// 'exit' listeners run synchronously, so an async DELETE there would silently delete nothing.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionOutcomes } from '../behavioral/_ledger.mjs';

const DRIVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'behavioral', '_driver.mjs');
const SCRATCH = mkdtempSync(join(tmpdir(), 'probe-session-cleanup-'));

let minted = 0;
let deletes = [];
let deleteStatus = 200;
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
      return new Response(null, { status: deleteStatus });
    }
    return new Response('not found', { status: 404 });
  },
});

/** Run `body` as a probe process that imports the driver: its exit, the DELETEs it caused, its ledger. */
async function probe(name, body, { status = 200, token = 'probe-token' } = {}) {
  const file = join(SCRATCH, `${name}.mjs`);
  const ledger = join(SCRATCH, `${name}.jsonl`);
  writeFileSync(file, `import { mintSession, deleteSession, sleep } from ${JSON.stringify(DRIVER)};\n${body}\n`);
  minted = 0;
  deletes = [];
  deleteStatus = status;
  const child = Bun.spawn([process.execPath, file], {
    env: { ...process.env, BASE: `http://127.0.0.1:${target.port}`, NIMBUS_PROBE_TOKEN: token, NIMBUS_PROBE_LEDGER: ledger },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const code = await child.exited;
  const text = existsSync(ledger) ? readFileSync(ledger, 'utf8') : '';
  const events = text ? text.trim().split('\n').map((l) => JSON.parse(l)).map((e) => `${e.event} ${e.sid} ${e.status}`) : [];
  return { code, signal: child.signalCode, deletes, events, outcomes: sessionOutcomes(text) };
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

target.stop(true);
rmSync(SCRATCH, { recursive: true, force: true });
console.log('probe-session-cleanup: all tests passed');
