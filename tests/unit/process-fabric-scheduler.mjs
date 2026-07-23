#!/usr/bin/env bun
// process-fabric-scheduler — the heavy/light process scheduler must:
//   (1) run `light` processes through the local NimbusLoadedEntrypoint path
//       exactly as before (supervisor = coordinator, stage forwarded);
//   (2) place `heavy` processes on a sibling peer DO, verifying the peer's
//       module-scope isolate token against the coordinator's own and every
//       token already in use, moving to the next slot on collision;
//   (3) fall back to the last probed candidate when every slot co-locates
//       (single-process dev topology) instead of failing the spawn;
//   (4) respawn a dead peer process ONCE on a fresh slot, gated on
//       shouldRespawn, and never after kill();
//   (5) kill() severs the peer chain via _rpcCancelHostProcess.
// Behavior is asserted through the public ProcessFabric surface only.

import assert from 'node:assert/strict';
import {
  ProcessFabric,
  ResidentProcessHandle,
  isolateToken,
  peerNamespaceFromEnv,
  HEAVY_PLACEMENT_MAX_ATTEMPTS,
} from '../../packages/worker/src/loaders/process-fabric.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { stagedProcessClass } from '../../packages/worker/src/facets/opencode-staging.ts';

// ── Runtime-spec policy declaration ─────────────────────────────────────
assert.equal(stagedProcessClass('attached'), 'heavy', 'attach TUI declares heavy');
assert.equal(stagedProcessClass('server'), 'light', 'serve declares light');
assert.equal(stagedProcessClass('oneshot'), 'light', 'oneshot declares light');

const STAGE = {
  mode: 'attached',
  argv: ['attach', 'http://127.0.0.1:4096'],
  env: {},
  cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  cwd: '/home/user',
  stdin: '',
  vfsBundle: '({})',
  vfsManifest: '{}',
  vfsMetadata: '{}',
};

// ── Local ctx.exports mock (light path + peer-leg parity) ───────────────
const localBoots = [];
setCtxExports({
  NimbusLoadedEntrypoint(options) {
    const boot = { props: options.props, started: false };
    localBoots.push(boot);
    return {
      startProcess() {
        boot.started = true;
        return Promise.resolve({ ok: true });
      },
    };
  },
});

function makeCtx() {
  const waited = [];
  return {
    id: { toString: () => 'coord-do-id' },
    waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); },
    waited,
  };
}

/**
 * Peer namespace mock: peers[name] supplies per-peer behavior
 * { token, host(stage, opts) } — host defaults to resolving {ok:true}.
 */
function makePeerNs(peerFor, log) {
  return {
    NIMBUS_SESSION: {
      idFromName(name) { return { name }; },
      get(id) {
        const peer = peerFor(id.name);
        return {
          async _rpcHostProcessProbe() {
            log.push(`probe:${id.name}`);
            return { isolateToken: peer.token };
          },
          async _rpcHostProcess(stage, opts) {
            log.push(`host:${id.name}`);
            return peer.host ? peer.host(stage, opts) : { ok: true };
          },
          async _rpcCancelHostProcess(workerKey) {
            log.push(`cancel:${id.name}:${workerKey}`);
            return { cancelled: true };
          },
        };
      },
    },
  };
}

// ── (1) light: local boot, supervisor = coordinator, stage forwarded ────
{
  const ctx = makeCtx();
  const fabric = new ProcessFabric(ctx, undefined); // light needs no peers
  const handle = await fabric.startResidentProcess({
    processClass: 'light', pid: 42, workerKey: 'nimbus-process:coord-do-id:42', stage: STAGE,
  });
  assert.ok(handle instanceof ResidentProcessHandle);
  assert.deepEqual(handle.placement, { kind: 'local' });
  await handle.done;
  const boot = localBoots.at(-1);
  assert.equal(boot.started, true, 'local startProcess invoked');
  assert.deepEqual(boot.props.supervisor, { doId: 'coord-do-id', pid: 42 });
  assert.equal(boot.props.key, 'nimbus-process:coord-do-id:42');
  assert.equal(boot.props.stage, STAGE, 'stage spec rides the entrypoint props');
  console.log('  case1: light process boots the local facet path');
}

// ── (2) heavy: distinct-token peer accepted; collision skips a slot ─────
{
  const log = [];
  const hosted = [];
  // Slot 0 reports the COORDINATOR's token (co-located) → slot 1 is used.
  const ns = makePeerNs((name) => ({
    token: name.endsWith(':proc:0') ? isolateToken() : `distinct-${name}`,
    host: (stage, opts) => { hosted.push({ name, stage, opts }); return { ok: true }; },
  }), log);
  const fabric = new ProcessFabric(makeCtx(), peerNamespaceFromEnv(ns));
  const handle = await fabric.startResidentProcess({
    processClass: 'heavy', pid: 7, workerKey: 'nimbus-process:coord-do-id:7', stage: STAGE,
  });
  assert.equal(handle.placement.kind, 'peer');
  assert.equal(handle.placement.slot, 1, 'co-located slot 0 skipped');
  assert.equal(handle.placement.peerName, 'coord-do-id:proc:1');
  await handle.done;
  assert.deepEqual(log.filter((l) => l.startsWith('host:')), ['host:coord-do-id:proc:1']);
  assert.equal(hosted[0].opts.coordinatorDoId, 'coord-do-id', 'syscalls route to the coordinator');
  assert.equal(hosted[0].opts.pid, 7);
  assert.equal(hosted[0].stage, STAGE);
  console.log('  case2: heavy process placed on a distinct-token peer (collision skipped)');
}

// ── (3) all-co-located fallback (dev single-process topology) ───────────
{
  const log = [];
  const ns = makePeerNs(() => ({ token: isolateToken() }), log); // every peer co-located
  const fabric = new ProcessFabric(makeCtx(), peerNamespaceFromEnv(ns));
  const handle = await fabric.startResidentProcess({
    processClass: 'heavy', pid: 8, workerKey: 'k8', stage: STAGE,
  });
  assert.equal(log.filter((l) => l.startsWith('probe:')).length, HEAVY_PLACEMENT_MAX_ATTEMPTS);
  assert.equal(handle.placement.kind, 'peer', 'spawn proceeds on the last candidate');
  await handle.done;
  console.log('  case3: all-co-located topology still spawns (placement is advisory)');
}

// ── (4a) peer death → one respawn on a FRESH slot, then success ─────────
{
  const log = [];
  let hostCalls = 0;
  const ns = makePeerNs((name) => ({
    token: `distinct-${name}`,
    host: () => {
      hostCalls++;
      if (hostCalls === 1) throw new Error('Worker exceeded memory limit.'); // peer OOM
      return { ok: true };
    },
  }), log);
  const fabric = new ProcessFabric(makeCtx(), peerNamespaceFromEnv(ns));
  const handle = await fabric.startResidentProcess({
    processClass: 'heavy', pid: 9, workerKey: 'k9', stage: STAGE,
    shouldRespawn: () => true,
  });
  await handle.done; // must NOT reject — the respawn cleared it
  assert.equal(handle.respawns, 1);
  assert.deepEqual(
    log.filter((l) => l.startsWith('host:')),
    ['host:coord-do-id:proc:0', 'host:coord-do-id:proc:1'],
    'respawn landed on a fresh slot (new machine lottery)',
  );
  console.log('  case4a: peer death respawns once on a fresh slot');
}

// ── (4b) respawn budget exhausted → lifecycle rejects ───────────────────
{
  const ns = makePeerNs((name) => ({
    token: `distinct-${name}`,
    host: () => { throw new Error('Worker exceeded memory limit.'); },
  }), []);
  const fabric = new ProcessFabric(makeCtx(), peerNamespaceFromEnv(ns));
  const handle = await fabric.startResidentProcess({
    processClass: 'heavy', pid: 10, workerKey: 'k10', stage: STAGE,
    shouldRespawn: () => true,
  });
  await assert.rejects(handle.done, /exceeded memory/, 'budget exhausted surfaces the death');
  assert.equal(handle.respawns, 1, 'exactly one respawn was attempted');
  console.log('  case4b: respawn budget is bounded (default 1)');
}

// ── (4c) shouldRespawn=false (killed/torn-down pid) → no respawn ────────
{
  const log = [];
  const ns = makePeerNs((name) => ({
    token: `distinct-${name}`,
    host: () => { throw new Error('facet died'); },
  }), log);
  const fabric = new ProcessFabric(makeCtx(), peerNamespaceFromEnv(ns));
  const handle = await fabric.startResidentProcess({
    processClass: 'heavy', pid: 11, workerKey: 'k11', stage: STAGE,
    shouldRespawn: () => false,
  });
  await assert.rejects(handle.done, /facet died/);
  assert.equal(log.filter((l) => l.startsWith('host:')).length, 1, 'no respawn for a torn-down pid');
  console.log('  case4c: shouldRespawn gate blocks respawn');
}

// ── (5) kill(): cancel RPC to the hosting peer + respawn blocked ────────
{
  const log = [];
  let rejectHost;
  const ns = makePeerNs((name) => ({
    token: `distinct-${name}`,
    host: () => new Promise((_res, rej) => { rejectHost = rej; }), // held open
  }), log);
  const ctx = makeCtx();
  const fabric = new ProcessFabric(ctx, peerNamespaceFromEnv(ns));
  const handle = await fabric.startResidentProcess({
    processClass: 'heavy', pid: 12, workerKey: 'k12', stage: STAGE,
    shouldRespawn: () => true, // pid still "running" — kill must still win
  });
  handle.kill();
  assert.equal(handle.killed, true);
  // Deterministic peer teardown: the cancel RPC severs the peer's held-open
  // startProcess, which rejects the held _rpcHostProcess on the coordinator.
  rejectHost(new Error('stub disposed'));
  await assert.rejects(handle.done, /stub disposed/);
  await Promise.all(ctx.waited);
  assert.deepEqual(log.filter((l) => l.startsWith('cancel:')), ['cancel:coord-do-id:proc:0:k12']);
  assert.equal(log.filter((l) => l.startsWith('host:')).length, 1, 'killed process never respawns');
  console.log('  case5: kill() cancels on the peer and blocks respawn');
}

// ── (6) missing NIMBUS_SESSION binding fails loud for heavy ─────────────
{
  const fabric = new ProcessFabric(makeCtx(), peerNamespaceFromEnv({}));
  await assert.rejects(
    fabric.startResidentProcess({ processClass: 'heavy', pid: 13, workerKey: 'k13', stage: STAGE }),
    /NIMBUS_SESSION/,
  );
  console.log('  case6: heavy without the peer namespace fails loud');
}

console.log('process-fabric-scheduler: all cases passed');
