#!/usr/bin/env bun
// A process's end, however it comes (its exit, a kill, a lost host), releases
// what it bound in the session's filesystem in the turn that ends it: its
// descriptor scope, and the subtree delegations it held. Nothing it held
// waits for the table to be pruned, where the next caller, a destroy among
// them, would find it with no one left to give it back.
//
// Red before (measured 2026-10-10, FancySole, current main): a server that
// held a delegation and whose facet was reset for its memory left the
// delegation in the session; the session's DELETE answered 500 EBUSY, since
// the destroy refuses on an exclusive mutation, until a reap or a read that
// recalled it (and waited out the dead holder's recall timeout). A live
// holder refused the DELETE for as long as it ran.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { rpcDestroy, rpcExec, rpcKillProcess, rpcProcessLogs, rpcStartProcess } from '../../packages/worker/src/session/programmatic.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { assumeGeneration } from '../../packages/fabric/src/generation.ts';
import { routeToSessionPort } from '../../packages/worker/src/session/port-capability.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld, createPeerNamespace } from './facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { programmaticHost } from './lib/programmatic-host.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

/** A session's filesystem and process table, composed as a workspace composes them. */
function session() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/repo', { recursive: true });
  kernel.chown('home/user', 1000, 1000);
  kernel.chown('home/user/repo', 1000, 1000);
  const orphaned = [];
  const filesystem = new ProcessFiles(engine, { delegationOrphaned: (event) => orphaned.push(event) });
  const processes = new SessionProcessSupervisor();
  processes.setRelease((pid) => filesystem.releaseProcess(pid));
  filesystem.holdOutput(processes);
  const op = createSupervisorOpHandler({ vfs: engine, filesystem, processes });
  return { engine, kernel, filesystem, processes, op, orphaned };
}

/** `pid` takes the subtree at `root` as a delegation, as a process's filesystem client does. */
async function delegate(s, pid, root = '/home/user/repo') {
  const grant = await s.op({ op: 'fsAcquireExclusiveMutation', args: [root, { delegate: { reads: true } }], pid });
  assert.equal(s.engine.hasExclusiveMutation(), true, 'the delegation is held');
  return grant;
}

/** What a holder's end must leave: no delegation, the subtree free, its binding over. */
function assertReleased(s, pid, what) {
  assert.equal(s.engine.hasExclusiveMutation(), false, `${what}: no exclusive mutation is left`);
  assert.equal(s.filesystem.delegations.size, 0, `${what}: no delegation is left`);
  assert.deepEqual(s.orphaned, [{ pid, root: 'home/user/repo' }], `${what}: said, naming the subtree`);
  s.kernel.writeFile('home/user/repo/after', 'free');
  assert.throws(() => s.filesystem.bind({ pid, cred: user }), /ESTALE/, `${what}: its binding is over`);
}

/** The session a destroy runs on: its filesystem and process table, and storage to wipe. */
function sessionHost(s, portRegistry = new PortRegistry()) {
  const storage = new Map();
  const host = {
    _w1SessionDestroyed: false,
    env: {},
    ctx: {
      getWebSockets: () => [],
      storage: {
        async get(k) { return storage.get(k); },
        async put(k, v) { storage.set(k, v); },
        async delete(k) { storage.delete(k); },
        async deleteAll() { storage.clear(); },
        async deleteAlarm() {},
      },
    },
    sqliteFs: s.engine,
    processes: s.processes,
    portRegistry,
    facetManager: null,
    shell: null,
    shellProcessPid: null,
    terminal: null,
    viteDevServer: null,
    cirrusReal: null,
    _cpRegistry: null,
    _viteShimPid: null,
    _viteShimPort: null,
    ensureSqliteFs() {},
    ensureFacetManager() {},
    initSession() {},
  };
  assumeGeneration(host.ctx, 1);
  return host;
}

// ── Every end releases at once, before any prune ────────────────────────────
for (const [what, end] of [
  ['its exit', (s, pid) => s.processes.exit(pid, 0)],
  ['a kill', (s, pid) => s.processes.kill(pid, 137)],
]) {
  const s = session();
  const { pid } = s.processes.spawn('node server.js', [], '/home/user', { cred: user });
  await delegate(s, pid);
  end(s, pid);
  assertReleased(s, pid, what);
  assert.notEqual(s.processes.get(pid), undefined, `${what}: the entry is the table's to prune`);
  assert.equal(await s.processes.reapTree(pid), 1, `${what}: pruned, with nothing to report`);
  assert.equal(s.processes.get(pid), undefined);
  console.log(`  ${what} releases what the process held`);
}

// ── A lost host ends a facet's process, which releases its delegation: the
//    session's destroy that follows at once is not refused ──────────────────
{
  const SID = 'tenant:end-releases';
  const RESET = 'Durable Object reset because its code was updated.';
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('served'); },
  }), { resolveConfig: false });
  const hostEnv = { LOADER: world.loader, ASSETS: stagedAssets };
  const { ns, peers } = createPeerNamespace(world, hostEnv, { coordinator: { doId: SID, supervisorOp: () => null } });
  const ctx = createFacetCtx(world, SID);
  const s = session();
  const portRegistry = new PortRegistry();
  const fm = new FacetManager(ctx, { ...hostEnv, NIMBUS_SESSION: ns, NIMBUS_PROCESS_HOST: 'peer' }, s.processes, portRegistry, processHostFor, { notify() {} });
  fm.setVfs(s.engine, s.filesystem);
  const { pid } = await fm.spawnNode('require("http").createServer(() => {}).listen(3000);', {
    command: 'node server.js', argv: ['/home/user/repo/server.js'], cwd: '/home/user/repo', port: 21900,
  });
  for (const deadline = Date.now() + 5_000; portRegistry.get(21900)?.pid !== pid;) {
    if (Date.now() > deadline) throw new Error('the server never took its port');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await delegate(s, pid);

  peers.get(`${SID}:proc:${pid}:0`).reset(new Error(RESET));
  const host = { ctx, portRegistry, ensureDurableAppOnPort: (port) => fm.ensureDurableAppOnPort(port) };
  const lost = await routeToSessionPort(host, 21900, new Request('https://app.test/'), '/', '');
  assert.equal(lost.status, 502, 'the request finds its host reset');
  for (const deadline = Date.now() + 2_000; s.processes.get(pid)?.state === 'running';) {
    if (Date.now() > deadline) throw new Error('the process never ended when its host was reset');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assertReleased(s, pid, 'a lost host');

  const destroyHost = sessionHost(s, portRegistry);
  const destroyed = await rpcDestroy(destroyHost, { reason: 'test' });
  assert.equal(destroyed.ok, true, 'the destroy that follows at once goes ahead');
  console.log('  a lost host releases what its process held, and the destroy after it goes ahead');
}

// ── A destroy stops a live holder, whose end gives its subtree back: the
//    user's explicit destroy is not refused for a delegation it ends itself.
//    Red before: refused EBUSY before anything was stopped, and again after
//    a read had recalled the subtree, while the holder ran. ─────────────────
{
  const s = session();
  const { pid } = s.processes.spawn('node server.js', [], '/home/user', { cred: user, longRunning: true });
  await delegate(s, pid);
  const destroyed = await rpcDestroy(sessionHost(s), { reason: 'test' });
  assert.equal(destroyed.ok, true, 'the destroy goes ahead');
  assert.equal(destroyed.killed, 1, 'having stopped the holder');
  assert.equal(s.filesystem.delegations.size, 0, 'whose end gave its subtree back');
  assert.deepEqual(s.orphaned, [{ pid, root: 'home/user/repo' }]);
  console.log('  a destroy stops a live holder and goes ahead');
}

// ── Work of the session's own that holds the filesystem still refuses it,
//    before anything is stopped ──────────────────────────────────────────────
{
  const s = session();
  const { pid } = s.processes.spawn('node server.js', [], '/home/user', { cred: user, longRunning: true });
  const lease = s.engine.acquireExclusiveMutation('home/user/repo');
  await assert.rejects(rpcDestroy(sessionHost(s), { reason: 'test' }), (error) => error.code === 'EBUSY');
  assert.equal(s.processes.get(pid)?.state, 'running', 'nothing was stopped');
  s.engine.releaseExclusiveMutation(lease.owner);
  console.log('  work of the session\'s own still refuses a destroy, before anything is stopped');
}

// ── A process the session runs is stopped, and its own cleanup closes its
//    descriptors before its end releases them: a shell job killed, or timed
//    out, with a redirection open closes its redirections and meets nothing
//    the release closed under it ─────────────────────────────────────────────
// Red before (RoughWallaby, c4aff8167): the kill's release closed the job's
// scope first; its redirection's close then failed EBADF, and the shell
// wrote that stack and exited 1. A timeout that ended the process before the
// shell's cleanup settled did the same.
{
  let asleep = null;
  const box = await programmaticHost({
    commands: {
      // Sleeps until it is stopped, then says so a moment later, still stopping.
      async sleep(ctx) {
        await new Promise((resolve) => {
          asleep?.();
          if (ctx.signal.aborted) resolve();
          ctx.signal.addEventListener('abort', resolve, { once: true });
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await ctx.stdout.write('stopped\n');
        return 130;
      },
    },
  });
  try {
    const { ws, host, held } = box;
    await ws.fs.writeFile('/home/user/in', 'input');
    const cred = ws.processes.cred(ws.shellProcessPid);
    for (const line of ['sleep 10 < /home/user/in', 'sleep 10 > /home/user/out']) {
      const sleeping = new Promise((resolve) => { asleep = resolve; });
      const { pid } = await rpcStartProcess(host, line);
      await sleeping;
      assert.equal((await rpcKillProcess(host, pid)).ok, true);
      await Promise.all(held.splice(0));
      const logged = (await rpcProcessLogs(host, pid)).chunks.map((chunk) => chunk.data).join('');
      assert.doesNotMatch(logged, /EBADF|Error/, `killed \`${line}\`: its cleanup met nothing closed under it: ${logged}`);
      if (!line.includes('>')) assert.match(logged, /stopped/, `killed \`${line}\`: what it wrote on being stopped is in its log`);
      assert.equal(ws.processes.get(pid)?.exitCode, 137, `killed \`${line}\`: it ends as killed`);
      assert.throws(() => ws.filesystem.bind({ pid, cred }), { code: 'ESTALE' }, `killed \`${line}\`: released once it had unwound`);
    }
    // A timed-out exec answers at its timeout, while its shell is still
    // stopping (the command takes a moment): what the job bound stays until
    // that shell has closed it, and goes after.
    const result = await rpcExec(host, 'sleep 10 > /home/user/out', { timeoutMs: 200 });
    assert.equal(result.exitCode, 124);
    assert.doesNotMatch(result.stderr, /EBADF|Error/, `a timed-out job's cleanup met nothing closed under it: ${result.stderr}`);
    const timedOut = Math.max(...ws.processes.getAll().filter((entry) => entry.command === 'sleep 10 > /home/user/out').map((entry) => entry.pid));
    assert.doesNotThrow(() => ws.filesystem.bind({ pid: timedOut, cred }), 'not released while its shell is still stopping');
    for (const deadline = Date.now() + 2_000; ;) {
      try { ws.filesystem.bind({ pid: timedOut, cred }); } catch (error) { if (error.code === 'ESTALE') break; throw error; }
      if (Date.now() > deadline) throw new Error('a timed-out job was never released');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    console.log('  a killed or timed-out shell job closes its own descriptors before its end releases them');
  } finally {
    box.close();
  }
}

console.log('process-end-releases-filesystem: ok');
