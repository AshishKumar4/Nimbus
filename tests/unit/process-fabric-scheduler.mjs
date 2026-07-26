#!/usr/bin/env bun
// process-fabric-scheduler — the resident-process scheduler must:
//   (1) boot a `light` process in the coordinator's own facet, staged or code;
//   (2) place a `heavy` process on a sibling peer DO, verifying the peer's
//       module-scope isolate token against the coordinator's own and every
//       token already in use, moving to the next slot on collision;
//   (3) fall back to the last probed candidate when every slot co-locates
//       (single-process dev topology) instead of failing the spawn;
//   (4) resolve a code spec's by-path wasm on the HOST, never shipping bytes;
//   (5) expose the SAME handle surface at either placement — boot payload,
//       route target, done, kill — with the route target following a respawn;
//   (6) respawn a dead peer ONCE on a fresh slot, gated on shouldRespawn, and
//       never after kill(); kill() severs the peer chain.
// Behavior is asserted through the public ProcessFabric surface only.

import assert from 'node:assert/strict';
import {
  ProcessFabric,
  ResidentProcessHandle,
  isolateToken,
  HEAVY_PLACEMENT_MAX_ATTEMPTS,
} from '../../packages/worker/src/loaders/process-fabric.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';
import { stagedProcessClass } from '../../packages/worker/src/facets/opencode-staging.ts';

// ── Runtime-spec policy declaration (the ONLY placement input) ──────────
// Heavy = resident AND non-serving. The attach TUI is the only mode that is
// both: it talks over the terminal RPC and the stdin pump and binds no port.
// `server` binds its route target into PortRegistry (and its readiness gate
// polls /doc back through that router), and a peer-hosted facet cannot serve
// inbound HTTP, so it stays local alongside the buffered one-shot run.
assert.equal(stagedProcessClass('attached'), 'heavy', 'the resident attach TUI declares heavy');
assert.equal(stagedProcessClass('server'), 'light', 'a serving opencode server stays local');
assert.equal(stagedProcessClass('oneshot'), 'light', 'a buffered one-shot run stays local');

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
const STAGED_BOOT = { kind: 'staged', stage: STAGE };
const CODE_BOOT = {
  kind: 'code',
  code: {
    compatibilityDate: '2025-01-01',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'worker.js',
    modules: { 'worker.js': 'export default {}' },
    vfsWasmModules: { 'ruby+stdlib.wasm': '/opt/ruby/share/ruby/ruby+stdlib.wasm' },
  },
};

// ── Local ctx.exports mock ──────────────────────────────────────────────
// A host boots a facet ONLY through NimbusLoadedEntrypoint: the module map is
// completed inside that stateless entrypoint, never in a session DO (workerd
// refuses to re-enter a dynamic worker a DO loaded for itself).
const localBoots = [];
setCtxExports({
  SupervisorRPC(options) {
    const binding = { props: options.props, disposed: false, [Symbol.dispose]() { binding.disposed = true; } };
    return binding;
  },
  NimbusLoadedEntrypoint(options) {
    const boot = {
      props: options.props,
      startArgs: undefined,
      started: false,
      disposed: false,
    };
    localBoots.push(boot);
    return {
      startProcess(args) {
        boot.started = true;
        boot.startArgs = args;
        return Promise.resolve({ ok: true, port: 8080 });
      },
      handleHttpRequest: (request) => Promise.resolve(new Response(`routed ${new URL(request.url).pathname}`)),
      [Symbol.dispose]() { boot.disposed = true; },
    };
  },
});

function makeEnv(peerNs) {
  return { env: peerNs ? { NIMBUS_SESSION: peerNs } : {} };
}

function makeCtx() {
  const waited = [];
  return {
    id: { toString: () => 'coord-do-id' },
    waitUntil(p) { waited.push(Promise.resolve(p).catch(() => {})); },
    waited,
  };
}

const WRITER_LIFECYCLE = {
  onWriterActivated() {},
  onWriterRetired() {},
};

/** Peer namespace mock: peerFor(name) supplies { token, host(boot, opts) }. */
function makePeerNs(peerFor, log) {
  const hostedByKey = new Map();
  return {
    hostedByKey,
    ns: {
      idFromName(name) { return { name }; },
      get(id) {
        const peer = peerFor(id.name);
        return {
          async _rpcHostProcessProbe() {
            log.push(`probe:${id.name}`);
            return { isolateToken: peer.token };
          },
          async _rpcHostProcess(boot, opts) {
            log.push(`host:${id.name}`);
            hostedByKey.set(opts.workerKey, { peer: id.name, boot, opts });
            return peer.host ? peer.host(boot, opts) : { ok: true };
          },
          async _rpcAwaitHostedBoot(workerKey) {
            log.push(`boot:${id.name}`);
            return { payload: { ok: true, hostedBy: id.name, workerKey } };
          },
          async _rpcRouteHostedHttp(workerKey, request) {
            log.push(`route:${id.name}`);
            return new Response(`peer ${id.name} ${new URL(request.url).pathname}`);
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

// ── (1) light + staged: local facet, supervisor = coordinator ───────────
{
  const { env } = makeEnv();
  const fabric = new ProcessFabric(makeCtx(), env);
  let retiredAfterDispose = false;
  let activatedWriter;
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    processClass: 'light', startContract: 'lifetime',
    pid: 42, workerKey: 'nimbus-process:coord-do-id:42', boot: STAGED_BOOT,
    onWriterActivated(writerId) {
      assert.equal(
        localBoots.some((candidate) => candidate.props.supervisor.writerId === writerId),
        false,
        'writer authority is activated before any local host capability is exposed',
      );
      activatedWriter = writerId;
    },
    onWriterRetired(writerId) {
      const ownedStubs = localBoots.filter(
        (candidate) => candidate.props.supervisor.writerId === writerId,
      );
      assert.equal(ownedStubs.length, 2);
      assert.ok(ownedStubs.every((candidate) => candidate.disposed));
      retiredAfterDispose = true;
    },
  });
  assert.ok(handle instanceof ResidentProcessHandle);
  assert.match(handle.describePlacement(), /local facet/);
  await handle.done;
  const boot = localBoots.find((b) => b.props.stage === STAGE);
  assert.ok(boot, 'stage spec rides the entrypoint props');
  assert.equal(boot.props.supervisor.doId, 'coord-do-id');
  assert.equal(boot.props.supervisor.pid, 42);
  assert.match(boot.props.supervisor.writerId, /^[0-9a-f-]{36}$/);
  assert.equal(boot.props.supervisor.writerId, activatedWriter);
  assert.equal(boot.props.key, 'nimbus-process:coord-do-id:42');
  assert.equal(boot.started, true, 'local startProcess invoked');
  assert.equal(retiredAfterDispose, true, 'writer retirement follows disposal of every host capability');
  console.log('  case1: light staged process boots the local facet path');
}

// ── (2) light + code: the spec rides the entrypoint, bytes never do ────
{
  const { env } = makeEnv();
  const fabric = new ProcessFabric(makeCtx(), env);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    processClass: 'light', startContract: 'boot',
    pid: 43, workerKey: 'k43', boot: CODE_BOOT, startArgs: { userCode: 'puts 1' },
  });
  assert.deepEqual(await handle.booted(), { ok: true, port: 8080 }, 'boot payload surfaces to the caller');
  const boot = localBoots.find((b) => b.props.residentCode);
  assert.deepEqual(boot.props.residentCode.vfsWasmModules, CODE_BOOT.code.vfsWasmModules,
    'the wasm image travels as a path; the DO never reads or carries its bytes');
  assert.equal(boot.props.residentCode.modules['ruby+stdlib.wasm'], undefined);
  assert.equal(boot.props.key, 'k43');
  assert.equal(boot.props.supervisor.doId, 'coord-do-id', 'syscalls route to the coordinator');
  assert.equal(boot.props.supervisor.pid, 43);
  assert.match(boot.props.supervisor.writerId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(boot.startArgs, { userCode: 'puts 1' }, 'startArgs reach the runner');
  assert.equal((await handle.routeTarget.handleHttpRequest(new Request('http://x/hi'))).status, 200);
  // A `boot` runner stays resident after its payload: `done` must not settle.
  let settled = false;
  handle.done.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settled, false, 'residency outlives the boot payload');
  handle.kill();
  await handle.done;
  console.log('  case2: light code process ships a spec, not an image');
}

// ── (3) heavy: distinct-token peer accepted; collision skips a slot ─────
{
  const log = [];
  // Slot 0 reports the COORDINATOR's token (co-located) → slot 1 is used.
  const peers = makePeerNs((name) => ({
    token: name.endsWith(':proc:0') ? isolateToken() : `distinct-${name}`,
  }), log);
  const { env } = makeEnv(peers.ns);
  const fabric = new ProcessFabric(makeCtx(), env);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    processClass: 'heavy', startContract: 'lifetime',
    pid: 7, workerKey: 'k7', boot: STAGED_BOOT,
  });
  assert.match(handle.describePlacement(), /peer slot=1/, 'co-located slot 0 skipped');
  await handle.done;
  assert.deepEqual(log.filter((l) => l.startsWith('host:')), ['host:coord-do-id:proc:1']);
  const hosted = peers.hostedByKey.get('k7');
  assert.equal(hosted.opts.coordinatorDoId, 'coord-do-id', 'syscalls route to the coordinator');
  assert.equal(hosted.opts.pid, 7);
  assert.equal(hosted.opts.startContract, 'lifetime');
  assert.deepEqual(hosted.boot, STAGED_BOOT, 'the boot spec crosses intact');
  console.log('  case3: heavy process placed on a distinct-token peer (collision skipped)');
}

// ── (4) heavy: identical handle surface — boot payload + routed HTTP ────
{
  const log = [];
  let releaseHost;
  const peers = makePeerNs((name) => ({
    token: `distinct-${name}`,
    host: () => new Promise((res) => { releaseHost = res; }),
  }), log);
  const { env } = makeEnv(peers.ns);
  const fabric = new ProcessFabric(makeCtx(), env);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    processClass: 'heavy', startContract: 'boot',
    pid: 44, workerKey: 'k44', boot: CODE_BOOT, startArgs: { a: 1 },
  });
  const hosted = peers.hostedByKey.get('k44');
  assert.deepEqual(hosted.opts.startArgs, { a: 1 }, 'startArgs cross to the host that boots the runner');
  assert.deepEqual(hosted.boot.code.vfsWasmModules, CODE_BOOT.code.vfsWasmModules,
    'the image travels as a path — the coordinator never reads or ships its bytes');
  assert.equal(hosted.boot.code.modules['ruby+stdlib.wasm'], undefined);
  assert.deepEqual(await handle.booted(), { ok: true, hostedBy: 'coord-do-id:proc:0', workerKey: 'k44' });
  // The fabric's own routing wire — coordinator → _rpcRouteHostedHttp on the
  // hosting peer. It stops at the peer: re-entering the peer's OWN facet to
  // serve the request is what workerd refuses (DataCloneError), which is why
  // no heavy-class primitive binds a port. Asserted here so the wire stays
  // intact for whenever that boundary is lifted.
  const routed = await handle.routeTarget.handleHttpRequest(new Request('http://x/doc'));
  assert.equal(await routed.text(), 'peer coord-do-id:proc:0 /doc', 'the request reaches the hosting peer');
  releaseHost({ ok: true });
  await handle.done;
  console.log('  case4: a peer-hosted process exposes the identical handle surface');
}

// ── (5) all-co-located fallback (dev single-process topology) ───────────
{
  const log = [];
  const peers = makePeerNs(() => ({ token: isolateToken() }), log); // every peer co-located
  const { env } = makeEnv(peers.ns);
  const fabric = new ProcessFabric(makeCtx(), env);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    processClass: 'heavy', startContract: 'lifetime', pid: 8, workerKey: 'k8', boot: STAGED_BOOT,
  });
  assert.equal(log.filter((l) => l.startsWith('probe:')).length, HEAVY_PLACEMENT_MAX_ATTEMPTS);
  assert.match(handle.describePlacement(), /^peer /, 'spawn proceeds on the last candidate');
  await handle.done;
  console.log('  case5: all-co-located topology still spawns (placement is advisory)');
}

// ── (6a) peer death → one respawn on a FRESH slot, route follows ────────
{
  const log = [];
  let hostCalls = 0;
  const writerIncarnations = [];
  const activatedWriters = [];
  const peers = makePeerNs((name) => ({
    token: `distinct-${name}`,
    host: (_boot, opts) => {
      assert.ok(
        activatedWriters.includes(opts.writerId),
        'peer writer authority is active before the host receives its capability',
      );
      hostCalls++;
      writerIncarnations.push(opts.writerId);
      if (hostCalls === 1) throw new Error('Worker exceeded memory limit.'); // peer OOM
      return { ok: true };
    },
  }), log);
  const { env } = makeEnv(peers.ns);
  const respawnCauses = [];
  const retiredWriters = [];
  const fabric = new ProcessFabric(makeCtx(), env);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    processClass: 'heavy', startContract: 'lifetime', pid: 9, workerKey: 'k9', boot: STAGED_BOOT,
    shouldRespawn: () => true,
    onRespawn: (cause) => respawnCauses.push(String(cause)),
    onWriterActivated: (writerId) => activatedWriters.push(writerId),
    onWriterRetired: (writerId) => retiredWriters.push(writerId),
  });
  await handle.done; // must NOT reject — the respawn cleared it
  assert.equal(handle.respawns, 1);
  assert.match(respawnCauses[0], /exceeded memory/, 'a recovered host death is never silent');
  assert.equal(new Set(writerIncarnations).size, 2,
    'a respawn gets a fresh trusted writer incarnation before its sequence restarts');
  assert.deepEqual(activatedWriters, writerIncarnations);
  assert.deepEqual(retiredWriters, writerIncarnations,
    'each host writer is retired only after that placement is disposed');
  assert.deepEqual(
    log.filter((l) => l.startsWith('host:')),
    ['host:coord-do-id:proc:0', 'host:coord-do-id:proc:1'],
    'respawn landed on a fresh slot (new machine lottery)',
  );
  const routed = await handle.routeTarget.handleHttpRequest(new Request('http://x/after'));
  assert.equal(await routed.text(), 'peer coord-do-id:proc:1 /after',
    'the port keeps serving across a respawn — PortRegistry never re-binds');
  console.log('  case6a: peer death respawns once on a fresh slot, route follows');
}

// ── (6b) respawn budget exhausted → lifecycle rejects ───────────────────
{
  const peers = makePeerNs((name) => ({
    token: `distinct-${name}`,
    host: () => { throw new Error('Worker exceeded memory limit.'); },
  }), []);
  const { env } = makeEnv(peers.ns);
  const fabric = new ProcessFabric(makeCtx(), env);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    processClass: 'heavy', startContract: 'lifetime', pid: 10, workerKey: 'k10', boot: STAGED_BOOT,
    shouldRespawn: () => true,
  });
  await assert.rejects(handle.done, /exceeded memory/, 'budget exhausted surfaces the death');
  assert.equal(handle.respawns, 1, 'exactly one respawn was attempted');
  console.log('  case6b: respawn budget is bounded (default 1)');
}

// ── (6c) shouldRespawn=false (killed/torn-down pid) → no respawn ────────
{
  const log = [];
  const peers = makePeerNs((name) => ({
    token: `distinct-${name}`,
    host: () => { throw new Error('facet died'); },
  }), log);
  const { env } = makeEnv(peers.ns);
  const fabric = new ProcessFabric(makeCtx(), env);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    processClass: 'heavy', startContract: 'lifetime', pid: 11, workerKey: 'k11', boot: STAGED_BOOT,
    shouldRespawn: () => false,
  });
  await assert.rejects(handle.done, /facet died/);
  assert.equal(log.filter((l) => l.startsWith('host:')).length, 1, 'no respawn for a torn-down pid');
  console.log('  case6c: shouldRespawn gate blocks respawn');
}

// ── (7) kill(): cancel RPC to the hosting peer + respawn blocked ────────
{
  const log = [];
  let rejectHost;
  const peers = makePeerNs((name) => ({
    token: `distinct-${name}`,
    host: () => new Promise((_res, rej) => { rejectHost = rej; }), // held open
  }), log);
  const { env } = makeEnv(peers.ns);
  const ctx = makeCtx();
  const fabric = new ProcessFabric(ctx, env);
  const handle = await fabric.startResidentProcess({
    ...WRITER_LIFECYCLE,
    processClass: 'heavy', startContract: 'lifetime', pid: 12, workerKey: 'k12', boot: STAGED_BOOT,
    shouldRespawn: () => true, // pid still "running" — kill must still win
  });
  handle.kill();
  assert.equal(handle.killed, true);
  // Deterministic peer teardown: the cancel RPC releases the peer's facet
  // resources, which settles the held _rpcHostProcess on the coordinator.
  rejectHost(new Error('stub disposed'));
  await assert.rejects(handle.done, /stub disposed/);
  await Promise.all(ctx.waited);
  assert.deepEqual(log.filter((l) => l.startsWith('cancel:')), ['cancel:coord-do-id:proc:0:k12']);
  assert.equal(log.filter((l) => l.startsWith('host:')).length, 1, 'killed process never respawns');
  console.log('  case7: kill() cancels on the peer and blocks respawn');
}

// ── (8) a missing peer namespace fails loud ────────────────────────────
{
  const fabric = new ProcessFabric(makeCtx(), {});
  await assert.rejects(
    fabric.startResidentProcess({
      ...WRITER_LIFECYCLE,
      processClass: 'heavy', startContract: 'lifetime', pid: 13, workerKey: 'k13', boot: STAGED_BOOT,
    }),
    /NIMBUS_SESSION/,
  );
  console.log('  case8: heavy without the peer namespace fails loud');
}

console.log('process-fabric-scheduler: all cases passed');
