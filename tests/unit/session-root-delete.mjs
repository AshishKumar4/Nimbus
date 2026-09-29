#!/usr/bin/env bun
// `DELETE /s/<id>/` destroys the session or says why it will not — never the
// session shell.
//
// The core router served the xterm UI shell for the session root whatever
// the method, so a DELETE answered 200 HTML and destroyed nothing; the
// behavioral driver counted that 200 as a deletion. On the hosted demo an
// anonymous session's DELETE reached the core router the same way, carrying
// its sid-pinned `session:attach` token (bearer or cookie).
//
// Asserted through the public handlers over a session whose state is real —
// a SqliteVFS on SQLite and a SessionProcessSupervisor, destroyed by the real
// rpcDestroy:
//   1. createNimbusHandler with the remote API: an authorized DELETE is
//      `box.destroy()` — JSON, the running process ended, the file and the
//      Durable Object storage gone; a repeat reports nothing left to kill;
//   2. a credential without destroy authority gets its auth error (401 with
//      none, 403 with an attach-only, a use-only or another session's token)
//      as JSON, and the session is untouched;
//   3. GET and HEAD still serve the shell; other root methods are 405;
//   4. without the remote API a root DELETE is 405, not the shell;
//   5. the hosted demo refuses an anonymous session's DELETE with 401 —
//      bearer or cookie — without reaching the session, and still serves it
//      the shell on GET.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Database } from 'bun:sqlite';

import { createNimbusHandler } from '../../packages/worker/src/router/index.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';
import { rpcDestroy } from '../../packages/worker/src/session/programmatic.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SESSION_DESTROYED_KEY } from '../../packages/worker/src/session/keys.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const SID = 'nimble-otter-4271';
const SHELL_HTML = '<!DOCTYPE html><title>session shell</title>';
const JWT_SECRET = 'session-root-delete-secret-0123456789abcdef';

/** A session Durable Object as the remote API reaches it: real SQLite state, the real destroy. */
function sessionState() {
  const harness = createSqliteVfsTestHarness();
  const stored = new Map([['proof', 'persisted']]);
  const host = {
    env: {},
    ctx: {
      getWebSockets: () => [],
      storage: {
        async get(key) { return stored.get(key); },
        async put(key, value) { stored.set(key, value); },
        async delete(key) { stored.delete(key); },
        async deleteAlarm() {},
        async deleteAll() {
          const tables = harness.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
          for (const { name } of tables) harness.db.exec(`DROP TABLE "${name.replaceAll('"', '""')}"`);
          stored.clear();
        },
      },
    },
    processes: new SessionProcessSupervisor(),
    portRegistry: new PortRegistry(),
    runtimeFsBridges: new Map(),
    sqliteFs: null,
    ensureSqliteFs() { this.sqliteFs ??= new SqliteVFS(harness.sql, harness.ctx); },
    terminal: null,
    facetManager: null,
  };
  host.ensureSqliteFs();
  const files = () => { host.ensureSqliteFs(); return host.sqliteFs.as(CRED_KERNEL); };
  files().mkdir('/home/user/proof', { recursive: true });
  files().writeFile('/home/user/proof/kept', 'persisted');
  const table = host.processes;
  const server = table.spawn('node', ['server.js'], '/home/user');
  let rpcCalls = 0;
  return {
    host, stored, table, pid: server.pid, files,
    get rpcCalls() { return rpcCalls; },
    _rpcDestroy(options) { rpcCalls++; return rpcDestroy(host, options); },
  };
}

const sessions = new Map();
const namespace = {
  idFromName: (name) => ({ name }),
  get(id) {
    if (!sessions.has(id.name)) sessions.set(id.name, sessionState());
    return sessions.get(id.name);
  },
};
const assetRequests = [];
const env = {
  JWT_SECRET,
  NIMBUS_SESSION: namespace,
  ASSETS: {
    async fetch(request) {
      assetRequests.push(`${request.method} ${new URL(request.url).pathname}`);
      return new Response(SHELL_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
  },
};
const ctx = { waitUntil() {} };
const token = (scopes, sid = SID) => issueNimbusToken(env, { tn: 'tenant', sub: 'owner', scopes, sid });
const at = (path, method, credential, headers = {}) => new Request(`https://nimbus.test${path}`, {
  method,
  headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), ...headers },
});

const withRemote = createNimbusHandler({ auth: { mode: 'enforce' }, sdk: { remote: true } });
const session = namespace.get(namespace.idFromName(`tenant:owner:${SID}`));

// ── 2. no destroy authority: an auth error, the session untouched ───────
{
  const refusals = [
    ['no credential', null, 401, 'E_TOKEN_MALFORMED'],
    ['attach-only', await token(['session:attach']), 403, 'E_SCOPE_MISSING'],
    ['use-only', await token(['sandbox:use', 'session:attach']), 403, 'E_SCOPE_MISSING'],
    ['another session', await token(['sandbox:use', 'session:destroy'], 'solemn-piper-6197'), 403, 'E_SESSION_PIN_MISMATCH'],
  ];
  for (const [label, credential, status, code] of refusals) {
    const response = await withRemote.fetch(at(`/s/${SID}/`, 'DELETE', credential), env, ctx);
    const body = await response.text();
    assert.equal(response.status, status, `${label}: ${body}`);
    assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/, `${label}: an auth error, not the shell`);
    assert.equal(JSON.parse(body).code, code, `${label}: ${body}`);
  }
  assert.equal(session.rpcCalls, 0, 'no refused DELETE reached the session');
  assert.equal(session.files().readFileString('/home/user/proof/kept'), 'persisted');
  assert.equal(session.table.get(session.pid).state, 'running');
  console.log('  [2] without destroy authority: 401/403 JSON, session untouched');
}

// ── 3. GET and HEAD serve the shell; other methods are 405 ──────────────
{
  const attach = await token(['session:attach']);
  for (const method of ['GET', 'HEAD']) {
    for (const path of [`/s/${SID}/`, `/s/${SID}`]) {
      assetRequests.length = 0;
      const response = await withRemote.fetch(at(path, method, attach), env, ctx);
      assert.equal(response.status, 200, `${method} ${path}`);
      assert.match(response.headers.get('Content-Type') ?? '', /^text\/html/);
      assert.deepEqual(assetRequests, ['GET /s/index.html'], `${method} ${path} serves the shell asset`);
    }
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'OPTIONS']) {
    assetRequests.length = 0;
    const response = await withRemote.fetch(at(`/s/${SID}/`, method, attach), env, ctx);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('Allow'), 'GET, HEAD, DELETE', method);
    assert.deepEqual(assetRequests, [], `${method} never serves the shell`);
  }
  console.log('  [3] GET/HEAD serve the shell; other root methods are 405');
}

// ── 1. an authorized DELETE is box.destroy() ────────────────────────────
{
  const destroyer = await token(['sandbox:use', 'session:destroy']);
  const before = Date.now();
  const response = await withRemote.fetch(at(`/s/${SID}/`, 'DELETE', destroyer, { 'X-Nimbus-Cleanup-Reason': 'probe-cleanup' }), env, ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.deepEqual({ ...body.result, destroyedAt: 0 }, { ok: true, killed: 1, destroyedAt: 0, reason: 'probe-cleanup' });
  assert.ok(body.result.destroyedAt >= before && body.result.destroyedAt <= Date.now());
  assert.notEqual(session.table.get(session.pid).state, 'running', 'the running process was ended');
  assert.equal(session.table.getExit(session.pid)?.code, 137);
  assert.equal(session.stored.has('proof'), false, 'Durable Object storage was deleted');
  assert.equal(typeof session.stored.get(SESSION_DESTROYED_KEY), 'number', 'the destroy is recorded');
  assert.equal(session.files().exists('/home/user/proof/kept'), false, 'the SQLite-backed file is gone');

  const repeat = await withRemote.fetch(at(`/s/${SID}`, 'DELETE', destroyer), env, ctx);
  assert.equal(repeat.status, 200);
  const again = await repeat.json();
  assert.equal(again.ok, true);
  assert.equal(again.result.killed, 0, 'nothing is left to kill');
  assert.equal(again.result.reason, null, 'no reason header, no reason');
  console.log('  [1] authorized DELETE destroys: JSON result, process ended, files and storage gone');
}

// ── 4. without the remote API, a root DELETE is 405 ─────────────────────
{
  const withoutRemote = createNimbusHandler({ auth: { mode: 'enforce' } });
  const other = namespace.get(namespace.idFromName('tenant:owner:solemn-piper-6197'));
  assetRequests.length = 0;
  const unauthenticated = await withoutRemote.fetch(at('/s/solemn-piper-6197/', 'DELETE', null), env, ctx);
  assert.equal(unauthenticated.status, 401);
  const attached = await withoutRemote.fetch(at('/s/solemn-piper-6197/', 'DELETE', await token(['session:attach', 'session:destroy'], 'solemn-piper-6197')), env, ctx);
  assert.equal(attached.status, 405);
  assert.equal(attached.headers.get('Allow'), 'GET, HEAD');
  assert.deepEqual(assetRequests, [], 'never the shell');
  assert.equal(other.rpcCalls, 0);
  console.log('  [4] without the remote API: 401 unauthenticated, 405 authenticated');
}

// ── 5. the hosted demo: an anonymous session's DELETE is 401 ────────────
{
  const root = new URL('../../', import.meta.url).pathname;
  const outputDir = await mkdtemp(join(tmpdir(), 'nimbus-root-delete-'));
  let demo;
  try {
    const build = await Bun.build({
      entrypoints: [join(root, 'apps/hosted-demo/src/index.ts')],
      outdir: outputDir,
      target: 'bun',
      format: 'esm',
      conditions: ['workspace'],
      plugins: [{
        name: 'cloudflare-workers-test-stub',
        setup(builder) {
          builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare-workers', namespace: 'test' }));
          // What the bundle imports from the runtime module: the base classes,
          // and `tracing`, which the Worker's entry adopts at module scope. An
          // untraced invocation's span, as workerd runs one without sampling.
          builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: 'export class DurableObject {}; export class WorkerEntrypoint {}; export class RpcTarget {};'
              + ' export const tracing = { enterSpan: (name, callback) => callback({ isTraced: false }) };',
            loader: 'js',
          }));
        },
      }],
    });
    assert.equal(build.success, true, build.logs.map(String).join('\n'));
    demo = await import(pathToFileURL(build.outputs.find((o) => o.path.endsWith('/index.js')).path).href);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
  const { createAnonDemoSession } = await import('../../apps/hosted-demo/src/demo-sessions.ts');
  const { issueAnonAttachToken } = await import('../../apps/hosted-demo/src/demo-nimbus.ts');

  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(new URL('../../apps/hosted-demo/migrations/0001_demo_auth.sql', import.meta.url), 'utf8'));
  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args),
    run: async () => ({ success: true, meta: { changes: db.prepare(sql).run(...params).changes } }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
  });
  const demoEnv = {
    ...env,
    DEMO_DB: {
      prepare: (sql) => statement(sql),
      batch: async (statements) => Promise.all(statements.map((s) => s.run())),
    },
    DEMO_ANON_TTL_SECONDS: '600',
    DEMO_ANON_MAX_ACTIVE: '10',
  };
  const anon = await createAnonDemoSession(demoEnv);
  const attach = await issueAnonAttachToken(demoEnv, anon);
  const anonSession = namespace.get(namespace.idFromName(`anon:anon:${anon.sessionId}`));
  const cookie = `__Host-nimbus_token=${encodeURIComponent(attach)}`;

  for (const [label, headers] of [['bearer', { Authorization: `Bearer ${attach}` }], ['cookie', { Cookie: cookie }]]) {
    for (const path of [`/s/${anon.sessionId}/`, `/s/${anon.sessionId}`]) {
      assetRequests.length = 0;
      const response = await demo.default.fetch(at(path, 'DELETE', null, headers), demoEnv, ctx);
      const body = await response.text();
      assert.equal(response.status, 401, `${label} ${path}: ${body}`);
      assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/, `${label}: not the shell`);
      assert.equal(JSON.parse(body).code, 'E_ANON_SESSION_TTL');
      assert.deepEqual(assetRequests, []);
    }
  }
  assert.equal(anonSession.rpcCalls, 0, 'the refused DELETE never reached the session');
  assert.equal(anonSession.files().readFileString('/home/user/proof/kept'), 'persisted');

  for (const method of ['GET', 'HEAD']) {
    assetRequests.length = 0;
    const shell = await demo.default.fetch(at(`/s/${anon.sessionId}/`, method, attach), demoEnv, ctx);
    assert.equal(shell.status, 200, `${method} still serves the anonymous session`);
    assert.deepEqual(assetRequests, ['GET /s/index.html']);
  }
  console.log('  [5] hosted demo: anonymous DELETE is 401 (bearer or cookie); GET/HEAD serve the shell');
}

console.log('session-root-delete OK');
