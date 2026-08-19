#!/usr/bin/env bun
// The identity a programmatic exec runs as.
//
// `SessionProcessSupervisor.spawn` has always taken a `cred`, `SqliteVFS.as`
// has always taken one, and the shell re-credentials per command from the
// process table — but `ProgrammaticExecOptions` had no way to name one, so a
// typed caller could only ever run as the session user. Naming it adds no
// semantics; it connects an option to machinery that already existed.
//
// It stops at the remote boundary. A bearer token authenticates a SESSION, not
// a user inside it, so a remote caller does not get to pick its own uid.

import assert from 'node:assert/strict';

import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { rpcExec, rpcStartProcess } from '../../packages/worker/src/session/programmatic.ts';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';

const AGENT = Object.freeze({ uid: 4242, gid: 4242, groups: Object.freeze([4242]), umask: 0o022 });

// ── exec runs as the credential it was given ────────────────────────────────
{
  const host = makeHost();
  await rpcExec(host, 'whoami', { cred: AGENT });
  assert.equal(host.spawned.length, 1);
  assert.deepEqual(
    host.processes.cred(host.spawned[0]),
    AGENT,
    'the spawned process carries the credential exec was given',
  );
}

// ── startProcess does too — a background job is the same spawn ──────────────
{
  const host = makeHost();
  await rpcStartProcess(host, 'server', { cred: AGENT });
  assert.deepEqual(host.processes.cred(host.spawned[0]), AGENT);
}

// ── omitted, nothing changes: the spawn inherits the session default ────────
{
  const host = makeHost();
  await rpcExec(host, 'whoami');
  const inherited = host.processes.cred(host.spawned[0]);
  assert.notEqual(inherited.uid, AGENT.uid, 'no credential means the default, not the last one used');
  assert.equal(typeof inherited.uid, 'number');
}

// ── the remote API refuses it, and does not reach the session ───────────────
{
  const calls = [];
  const env = makeRemoteEnv(calls);

  const refused = await remoteExec(env, ['id', { cred: { uid: 0, gid: 0, groups: [0], umask: 0 } }]);
  assert.equal(refused.status, 400, 'a remote caller naming a uid is refused');
  const body = await refused.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, 'E_ARG_SHAPE');
  assert.match(body.error, /cred/);
  assert.deepEqual(calls, [], 'the refusal happens before the session is asked');

  // Refused, not dropped: an ordinary exec still goes through untouched.
  const allowed = await remoteExec(env, ['id', { cwd: '/home/user' }]);
  assert.equal(allowed.status, 200);
  assert.equal(calls.length, 1, 'an exec without a credential is forwarded');
  assert.equal(calls[0].options.cred, undefined);
}

console.log('programmatic exec credential: ok');

function makeHost() {
  const processes = new SessionProcessSupervisor();
  const spawned = [];
  const originalSpawn = processes.spawn.bind(processes);
  processes.spawn = (command, argv, cwd, opts) => {
    const entry = originalSpawn(command, argv, cwd, opts);
    spawned.push(entry.pid);
    return entry;
  };
  return {
    _w1SessionDestroyed: false,
    env: {},
    ctx: { waitUntil: () => {}, storage: {} },
    shell: {
      getEnv: () => ({ HOME: '/home/user' }),
      getCwd: () => '/home/user',
      execute: async () => ({ exitCode: 0 }),
    },
    shellProcessPid: null,
    sqliteFs: {},
    processes,
    spawned,
    portRegistry: { getAll: () => [] },
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: {},
    _viteShimPid: null,
    _viteShimPort: null,
    terminal: null,
    ensureSqliteFs() {},
    ensureFacetManager() {},
    initSession() { throw new Error('the test host is already booted'); },
  };
}

// `allowLegacy` with no JWT_SECRET is the documented unauthenticated path, and
// it is the weakest caller there is — exactly the one that must not be able to
// choose a uid.
function makeRemoteEnv(calls) {
  return {
    NIMBUS_SESSION: {
      idFromName: (name) => ({ name }),
      get: () => ({
        _rpcExec: async (command, options) => {
          calls.push({ command, options });
          return { command, exitCode: 0, success: true, stdout: '', stderr: '', durationMs: 0 };
        },
      }),
    },
  };
}

function remoteExec(env, args) {
  return handleNimbusRemoteApi(
    new Request('https://example.test/api/nimbus/v1/sandboxes/s1/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'exec', args }),
    }),
    env,
    { remote: { enabled: true, allowLegacy: true } },
  );
}
