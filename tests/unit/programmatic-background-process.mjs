#!/usr/bin/env bun

// startProcess must background: return a live handle immediately, keep
// streaming output into the process log ring, record the exit when the
// command finishes, and terminate on kill. exec keeps its foreground
// contract, and the two must not steal each other's output.

import assert from 'node:assert/strict';

import { SessionProcessSupervisor } from '../../packages/worker/src/runtime/session-process-supervisor.ts';
import {
  rpcExec,
  rpcKillProcess,
  rpcProcessLogs,
  rpcStartProcess,
} from '../../packages/worker/src/session/programmatic.ts';

const SLEEP_MS = 400;

function makeHost() {
  const processes = new SessionProcessSupervisor();
  const held = [];
  const shell = {
    getEnv: () => ({ HOME: '/home/user' }),
    getCwd: () => '/home/user',
    async execute(command, options) {
      const [name, argument] = String(command).split(/\s+/);
      if (name === 'sleep') {
        const ms = Number(argument) * 1000;
        options.onStdout?.('starting\n');
        const aborted = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), ms);
          options.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve(true);
          }, { once: true });
        });
        if (aborted) return { exitCode: 130 };
        options.onStdout?.('woke\n');
        return { exitCode: 0 };
      }
      if (name === 'spawner') {
        // A command whose output lands in a child's ring, not on the caller's
        // streams — the npm-bin / facet-backed runtime shape.
        const child = processes.spawn(command, [command], '/home/user', {
          parentPid: options.commandContext?.pid,
        });
        processes.appendOutput(child.pid, 'stdout', `child of ${argument}\n`);
        processes.exit(child.pid, 0);
        return { exitCode: 0 };
      }
      options.onStdout?.(`${command}\n`);
      return { exitCode: 0 };
    },
  };
  return {
    _w1SessionDestroyed: false,
    env: {},
    ctx: { waitUntil: (promise) => held.push(promise), storage: {} },
    shell,
    shellProcessPid: null,
    sqliteFs: {},
    processes,
    portRegistry: { getAll: () => [] },
    facetManager: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: {},
    _viteShimPid: null,
    _viteShimPort: null,
    terminal: null,
    held,
    ensureSqliteFs() {},
    ensureFacetManager() {},
    initSession() { throw new Error('the test host is already booted'); },
  };
}

// ── startProcess returns before the process completes ────────────────────
{
  const host = makeHost();
  const before = Date.now();
  const started = await rpcStartProcess(host, `sleep ${SLEEP_MS / 1000}`);
  const elapsed = Date.now() - before;

  assert.ok(
    elapsed < SLEEP_MS / 2,
    `startProcess returned in ${elapsed}ms, which is not ahead of the ${SLEEP_MS}ms command`,
  );
  assert.equal(typeof started.pid, 'number');
  assert.equal(started.process.state, 'running');
  assert.equal(started.process.longRunning, true);
  assert.equal(host.held.length, 1, 'the session holds the background work open');

  // Incremental output is readable while the process is still running.
  const early = await rpcProcessLogs(host, started.pid);
  assert.equal(early.text, 'starting\n');
  assert.equal(early.exit, null);
  assert.equal(host.processes.get(started.pid).state, 'running');

  await host.held[0];

  const done = await rpcProcessLogs(host, started.pid);
  assert.equal(done.text, 'starting\nwoke\n');
  assert.deepEqual(
    { state: host.processes.get(started.pid).state, code: done.exit?.code },
    { state: 'exited', code: 0 },
    'the handle reports completion once the command finishes',
  );
}

// ── kill terminates a running background process ─────────────────────────
{
  const host = makeHost();
  const started = await rpcStartProcess(host, `sleep ${SLEEP_MS / 1000}`);
  const killedAt = Date.now();
  const killed = await rpcKillProcess(host, started.pid);
  assert.deepEqual(killed, { ok: true, pid: started.pid });

  await host.held[0];
  assert.ok(
    Date.now() - killedAt < SLEEP_MS / 2,
    'kill aborts the running command instead of waiting it out',
  );
  assert.equal(host.processes.get(started.pid).state, 'killed');
}

// ── exec still waits for completion ──────────────────────────────────────
{
  const host = makeHost();
  const before = Date.now();
  const result = await rpcExec(host, `sleep ${SLEEP_MS / 1000}`);
  assert.ok(Date.now() - before >= SLEEP_MS * 0.8, 'exec awaits the command');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'starting\nwoke\n');
}

// ── concurrent execs do not collect each other's ring output ─────────────
{
  const host = makeHost();
  const [first, second] = await Promise.all([
    rpcExec(host, 'spawner one'),
    rpcExec(host, 'spawner two'),
  ]);
  assert.equal(first.stdout, 'child of one\n');
  assert.equal(second.stdout, 'child of two\n');
}

console.log('programmatic background process: ok');
