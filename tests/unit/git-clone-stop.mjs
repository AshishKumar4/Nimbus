#!/usr/bin/env bun
// git-clone-stop — a clone stops with its command, and a destroy stops it.
//
//   - Ctrl-C (an exec's stop with SIGINT's reason): the clone's facet call is
//     let go; it removes its junk, as git's signal handler does, then its
//     record goes, then its lease; it ends 130.
//   - A kill of a background clone's process stops it the same way.
//   - A destroy during a clone goes ahead: it stops the clone (through the
//     session's facet manager, as a session has one), which leaves its junk
//     to the wipe and writes nothing after its record goes, and is answered
//     once the clone has let go of its lease. A lease no process holds is
//     still refused, EBUSY, which the remote API answers 409, before anything
//     is stopped: the session's shell runs the next line.
//
// Red before: execGitNetwork took no stop, so the clone ran on past a Ctrl-C
// or a kill, and a destroy during a clone answered 500 EBUSY.
import assert from 'node:assert/strict';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { rpcDestroy } from '../../packages/worker/src/session/programmatic.ts';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';
import { issueNimbusToken } from '../../packages/worker/src/auth/token.ts';
import { ISOLATE_NETWORK } from '../../packages/core/src/_shared/workspace-network.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { signalAbortReason } from '../../packages/core/src/substrate/lifo/shell/signals.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { assumeGeneration } from '../../packages/fabric/src/generation.ts';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { programmaticHost } from './lib/programmatic-host.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';

adoptCtxExports({
  SupervisorRPC: (options) => ({ props: options.props, async stdout() {}, [Symbol.dispose]() {} }),
});

const until = async (what, done) => {
  for (let i = 0; i < 1000 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(done(), what);
};

/**
 * A session whose git clones reach a facet that does what a prepare does
 * first (the job's marker, then a file of the clone, as the binding's lease
 * owner) and then runs until its caller lets it go.
 */
async function cloneSession() {
  const box = await programmaticHost();
  const { ws, host } = box;
  // What a facet writes, it writes as its process's credential: the session user's here.
  const user = ws.processes.cred(ws.shellProcessPid);
  const facet = { prepared: 0, released: 0 };
  const env = {
    ASSETS: stagedAssets,
    LOADER: {
      load(code) {
        const owner = code.env.SUPERVISOR.props.mutationOwner;
        return {
          getEntrypoint: () => ({
            async fetch(request) {
              const body = await request.json();
              const dir = body.dir.replace(/^\/+/, '');
              const writes = ws.vfs.as(user, { mutationOwner: owner });
              writes.mkdir(dir + '/.git', { recursive: true });
              writes.writeFile(dir + '/.git/nimbus-clone-job', JSON.stringify({ version: 1, jobId: body.jobId, optionsHash: body.optionsHash }));
              writes.writeFile(dir + '/README', 'partial');
              facet.prepared++;
              await new Promise((_, reject) => request.signal.addEventListener('abort', () => {
                facet.released++;
                reject(request.signal.reason);
              }, { once: true }));
            },
          }),
        };
      },
    },
  };
  Object.assign(host.ctx, { id: { toString: () => 'clone-stop-session' }, getWebSockets: () => [] });
  Object.assign(host.ctx.storage, { async deleteAll() { box.rows.clear(); }, async deleteAlarm() {} });
  assumeGeneration(host.ctx, 1);
  ws.registry.register('git', (ctx) => runGitCommand(ctx, ws.vfs, host.ctx, env, ISOLATE_NETWORK, ws.filesystem, ws.processes));
  // The session's facet manager, over the session's process table: a destroy kills through it.
  const world = createFacetWorld(() => ({ async startProcess() { return { ok: true }; } }));
  host.facetManager = new FacetManager(createFacetCtx(world, 'clone-stop-facets'), { LOADER: world.loader, ASSETS: stagedAssets },
    ws.processes, new PortRegistry(), processHostFor, { requestLaunchTurn: () => {}, onExternalExit: () => {} });
  host.facetManager.setVfs(ws.vfs, ws.filesystem);
  const records = () => [...box.rows.keys()].filter((key) => key.startsWith('git-clone-job:'));
  return { box, ws, host, facet, records };
}

// ── Ctrl-C: the junk goes, then the record, then the lease; 130 ──
{
  const { box, ws, facet, records } = await cloneSession();
  try {
    const interrupt = new AbortController();
    const clone = ws.exec('git clone https://example.invalid/r.git /home/user/r', { signal: interrupt.signal });
    await until('the clone reached its facet', () => facet.prepared === 1);
    assert.equal(records().length, 1, 'the clone is recorded');
    assert.equal(ws.vfs.hasExclusiveMutation(), true, 'and holds its lease');
    interrupt.abort(signalAbortReason('INT'));
    const result = await clone;
    assert.equal(result.exitCode, 130, result.stderr);
    assert.equal(result.stderr, '', 'it ends silently, as git does on SIGINT');
    assert.equal(facet.released, 1, 'its facet call was let go');
    assert.equal(ws.vfs.as(CRED_KERNEL).exists('home/user/r'), false, 'its junk is removed');
    assert.deepEqual(records(), [], 'its record goes');
    assert.equal(ws.vfs.hasExclusiveMutation(), false, 'and its lease');
    console.log('  Ctrl-C stops a clone: junk removed, record and lease gone, 130');
  } finally {
    box.close();
  }
}

// ── A kill of a background clone's process stops it the same way ──
{
  const { box, ws, facet, records } = await cloneSession();
  try {
    const started = await ws.exec('git clone --bg https://example.invalid/r.git /home/user/r');
    assert.equal(started.exitCode, 0, started.stderr);
    const pid = Number(/pid (\d+)/.exec(started.stdout)?.[1]);
    assert.equal(ws.processes.get(pid)?.state, 'running', 'the background clone is a process of its own');
    await until('the clone reached its facet', () => facet.prepared === 1);
    ws.processes.kill(pid);
    await until('the clone let go of its lease', () => !ws.vfs.hasExclusiveMutation());
    assert.equal(facet.released, 1);
    assert.equal(ws.vfs.as(CRED_KERNEL).exists('home/user/r'), false, 'its junk is removed');
    assert.deepEqual(records(), []);
    await Promise.all(box.held.splice(0));
    console.log('  a kill of a background clone stops it the same way');
  } finally {
    box.close();
  }
}

// ── A destroy during a clone goes ahead, and leaves nothing of it behind ──
for (const background of [false, true]) {
  const { box, ws, host, facet, records } = await cloneSession();
  try {
    const clone = ws.exec(`git clone ${background ? '--bg ' : ''}https://example.invalid/r.git /home/user/r`);
    await until('the clone reached its facet', () => facet.prepared === 1);
    const destroyed = await rpcDestroy(host, { reason: 'test' });
    assert.equal(destroyed.ok, true, 'the destroy goes ahead');
    assert.equal(facet.released, 1, 'having stopped the clone');
    // Whatever of the clone was still to run has run: it wrote nothing into the wiped storage.
    await clone;
    await Promise.all(box.held.splice(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(records(), [], 'the re-created session finds no record of the clone');
    assert.equal(ws.vfs.as(CRED_KERNEL).exists('home/user/r/README'), true, 'its junk was left to the wipe');
    console.log(`  a destroy during a${background ? ' background' : ''} clone goes ahead and leaves no record`);
  } finally {
    box.close();
  }
}

// ── A lease no process holds still refuses the destroy, before anything is
//    stopped, which the remote API answers 409 ──
{
  const { box, ws, host } = await cloneSession();
  try {
    const lease = ws.vfs.acquireExclusiveMutation('home/user');
    await assert.rejects(rpcDestroy(host, { reason: 'test' }), (error) => error.code === 'EBUSY');
    ws.vfs.releaseExclusiveMutation(lease.owner);
    assert.equal(ws.processes.get(ws.shellProcessPid)?.state, 'running', 'the refused destroy stopped nothing');
    const line = await ws.shell.execute('echo still-here', {});
    assert.equal(line.exitCode, 0, line.stderr);
    assert.equal(line.stdout, 'still-here\n', 'the session\'s shell runs the next line');
    const env = {
      JWT_SECRET: 'unit-clone-stop-secret',
      NIMBUS_SESSION: {
        idFromName: (name) => name,
        get: () => ({ _rpcDestroy: (options) => rpcDestroy(host, options) }),
      },
    };
    ws.vfs.acquireExclusiveMutation('home/user');
    const token = await issueNimbusToken(env, { tn: 'unit', sub: 'owner', scopes: ['sandbox:use', 'session:destroy'], sid: 'clone-stop' });
    const response = await handleNimbusRemoteApi(new Request('https://unit.test/api/nimbus/v1/sandboxes/clone-stop/rpc', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'destroy', args: [{}] }),
    }), env, { remote: true });
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json()).code, 'EBUSY');
    console.log('  a lease no process holds still refuses the destroy, stopping nothing: 409');
  } finally {
    box.close();
  }
}

console.log('git-clone-stop: ok');
