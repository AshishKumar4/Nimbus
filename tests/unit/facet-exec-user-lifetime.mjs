#!/usr/bin/env bun
//
// A user-invoked one-shot exec has no wall-clock lifetime: the 30s kill that
// `_execWithTimeout` used to arm is gone, so a program that runs longer than
// the old bound returns its real exit, and the only early ending left is a
// kill — Ctrl-C on the pid aborts the in-flight run.
//
// The pins are observable, not structural:
//   1. exec() over a program the fake host holds open returns that program's
//      real exit code — and no 30s-class timer is armed anywhere in the run;
//   2. kill(pid) mid-run aborts the request signal the facet fetch carries,
//      so the run actually ends rather than outliving the table row;
//   3. the drain loop with no deadline still waits on a program's pending
//      timer and reports it finished when it fires.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FacetManager, ENTRYPOINT_EVENT_LOOP } from '../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

adoptCtxExports({
  SupervisorRPC: ({ props }) => ({ props }),
  NimbusLoadedEntrypoint: () => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }),
});

/**
 * A manager whose one-shot runs are answered by `runOnce` — a fake host that
 * behaves the way workerd's does: it consumes the module map, then holds the
 * request (whose signal is the only kill channel) until `behave` resolves.
 */
function makeManager(label, behave) {
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }));
  const ctx = createFacetCtx(world, label);
  const processes = new SessionProcessSupervisor();
  const env = {
    LOADER: world.loader,
    ASSETS: {
      async fetch(request) {
        const path = new URL(request.url).pathname.replace(/^\//, '');
        return new Response(
          readFileSync(new URL(`../../packages/worker/public/${path}`, import.meta.url)),
          { status: 200 },
        );
      },
    },
  };
  const hostFactory = () => ({
    imageDelivery: { reflink: 'same-object', moduleCeilingBytes: 1 << 26, storageSharedWithSession: true },
    async runOnce(params, consume) {
      await params.code();
      params.onWriterActivated(params.writerId);
      params.onLoaded?.();
      return consume(await behave(params));
    },
    async open() { throw new Error('resident spawn is not under test'); },
  });
  const manager = new FacetManager(ctx, env, processes, new PortRegistry(), hostFactory, {});
  const harness = createSqliteVfsTestHarness();
  manager.setVfs(new SqliteVFS(harness.sql, harness.ctx));
  return { manager, processes };
}

// ── 1. A program past the old bound is not killed ────────────────────────────
// The program holds its run open for a while; the old machinery would have
// exited it 124 at 30s (or its 27s drain deadline). Under a timer spy we can
// also say precisely that no wall-clock kill was armed at all.
{
  const { manager, processes } = makeManager('long-run', async (params) => {
    await new Promise((r) => setTimeout(r, 300));
    return Response.json({ exitCode: 42, stdout: 'done\n', stderr: '' });
  });

  const armed = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    armed.push(ms);
    return realSetTimeout(fn, ms, ...rest);
  };
  let result;
  try {
    result = await manager.exec('console.log("done")', { filename: '/home/user/run.js', cwd: '/home/user' });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  assert.equal(result.exitCode, 42, 'the program\'s real exit did not survive the run');
  assert.equal(result.stdout, 'done\n');
  const entry = [...processes.getAll()].find((p) => p.command.includes('run.js'));
  assert.equal(entry?.state, 'exited');
  assert.equal(entry?.exitCode, 42);
  assert.ok(
    !armed.some((ms) => ms >= 25_000 && ms <= 65_000),
    `a wall-clock kill/dispatch timer was armed during the run: ${JSON.stringify(armed.filter((m) => m >= 25_000))}`,
  );
}

// ── 2. Ctrl-C still kills it ─────────────────────────────────────────────────
// kill() marks the table row AND fires the terminator exec registered, which
// aborts the signal the runOnce request carries — the fetch must actually end.
{
  const { manager, processes } = makeManager('ctrl-c', async (params) => {
    return await new Promise((_resolve, reject) => {
      params.request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  });

  const running = manager.exec('setInterval(() => {}, 1000)', { filename: '/home/user/hang.js', cwd: '/home/user' });
  // Let the run reach the fake host before the kill lands.
  await new Promise((r) => setTimeout(r, 150));
  const entry = [...processes.getAll()].find((p) => p.command.includes('hang.js'));
  assert.ok(entry, 'the process entry exists');
  assert.equal(manager.kill(entry.pid), true);

  const result = await running;
  assert.equal(result.exitCode, 130, 'a killed program reports the signal, not a crash');
  assert.equal(result.stderr, '', 'the abort text is not the program\'s stderr');
  assert.equal(processes.get(entry.pid)?.state, 'killed', 'kill did not reach terminal state');
  assert.equal(processes.get(entry.pid)?.exitCode, 137);
}

// ── 3. The drain with no deadline still waits on real work ───────────────────
const loop = new Function(
  '__nimbusProcessExitPromise',
  ENTRYPOINT_EVENT_LOOP + `
  return {
    runEventLoop: __nimbusRunEventLoop,
    runEntrypointToExit: __nimbusRunEntrypointToExit,
  };`,
);

{
  globalThis.__nimbusPendingTimers = 0;
  globalThis.__nimbusPendingOps = 0;
  globalThis.__portRegistry = new Map();
  const l = loop(new Promise(() => {}));
  let fired = false;
  globalThis.__nimbusPendingTimers++;
  setTimeout(() => { globalThis.__nimbusPendingTimers--; fired = true; }, 250);

  const r = await l.runEntrypointToExit(undefined, Infinity);
  assert.equal(fired, true, 'the unbounded drain abandoned a pending timer');
  assert.equal(r.pending, 0);
}

globalThis.__nimbusPendingTimers = 0;
globalThis.__nimbusPendingOps = 0;
globalThis.__portRegistry = new Map();
console.log('ok - facet-exec-user-lifetime');
