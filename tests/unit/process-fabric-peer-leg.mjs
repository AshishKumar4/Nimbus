#!/usr/bin/env bun
// process-fabric-peer-leg — the peer-DO host leg of the resident-process
// scheduler must:
//   (1) answer the placement probe with the module-scope isolate token;
//   (2) boot a staged process from the PEER's own loader with the SUPERVISOR
//       routed to the COORDINATOR's doId (never the peer's), holding the RPC
//       open until the process lifecycle ends;
//   (3) boot a code process the same way, forwarding its by-path wasm image
//       for the loading entrypoint to resolve, and keep holding after the
//       runner returns its boot payload;
//   (4) serve inbound HTTP for a hosted process, and hand back the boot
//       payload, without either leg racing the host leg;
//   (5) validate opts / boot spec at the RPC trust boundary;
//   (6) tear the hosted facet down on _rpcCancelHostProcess.

import assert from 'node:assert/strict';
import {
  _rpcHostProcessProbe,
  _rpcHostProcess,
  _rpcAwaitHostedBoot,
  _rpcRouteHostedHttp,
  _rpcCancelHostProcess,
} from '../../packages/worker/src/session/rpc.ts';
import { isolateToken } from '../../packages/worker/src/loaders/process-fabric.ts';
import { setCtxExports } from '../../packages/worker/src/session/ctx-exports.ts';

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
const OPTS = {
  coordinatorDoId: 'coordinator-do-id',
  pid: 21,
  writerId: '11111111-1111-4111-8111-111111111111',
  workerKey: 'nimbus-process:coordinator-do-id:21',
  startContract: 'lifetime',
};

// Peer-side ctx.exports mock: the staged startProcess resolves when the test
// releases it; the stub's Symbol.dispose (what disposeRpcResource invokes)
// rejects it — mirroring workerd severing a held-open loopback RPC.
const boots = [];
setCtxExports({
  SupervisorRPC(options) {
    const binding = { props: options.props, disposed: false, [Symbol.dispose]() { binding.disposed = true; } };
    return binding;
  },
  NimbusLoadedEntrypoint(options) {
    const boot = { props: options.props, disposed: false };
    boot.lifecycle = new Promise((resolve, reject) => {
      boot.resolve = resolve;
      boot.rejectAsDisposed = () => reject(new Error('stub disposed'));
    });
    boot.lifecycle.catch(() => {});
    boots.push(boot);
    return {
      startProcess: (args) => { boot.running = true; boot.startArgs = args; return boot.lifecycle; },
      handleHttpRequest: (request) => Promise.resolve(new Response(`hosted ${new URL(request.url).pathname}`)),
      [Symbol.dispose]() {
        boot.disposed = true;
        // Only a stub whose held-open call is outstanding can be severed;
        // disposing an idle route stub must not manufacture a failure.
        if (boot.running) boot.rejectAsDisposed();
      },
    };
  },
});

/** Peer DO mock: nothing but the hosted-process registry the legs use. */
function makeSelf() {
  return {
    _hostedProcesses: new Map(),
    _hostedProcessWaiters: new Map(),
  };
}

// ── (1) probe returns the module-scope isolate token ────────────────────
{
  const probe = _rpcHostProcessProbe(makeSelf());
  assert.equal(probe.isolateToken, isolateToken(), 'probe reports this isolate/process identity');
  assert.equal(_rpcHostProcessProbe(makeSelf()).isolateToken, probe.isolateToken, 'token is stable');
  console.log('  case1: placement probe returns the stable isolate token');
}

// ── (2) staged: peer boots the facet, SUPERVISOR routed to coordinator ──
{
  const self = makeSelf();
  const hosted = _rpcHostProcess(self, STAGED_BOOT, OPTS);
  await new Promise((r) => setTimeout(r, 0));
  const boot = boots.at(-1);
  assert.deepEqual(
    boot.props.supervisor,
    {
      doId: 'coordinator-do-id',
      pid: 21,
      writerId: OPTS.writerId,
    },
    'syscalls route to the COORDINATOR, not this peer',
  );
  assert.equal(boot.props.key, OPTS.workerKey);
  assert.deepEqual(boot.props.stage, STAGE, 'validated stage spec forwarded to the assembler');
  assert.equal(self._hostedProcesses.size, 1, 'host record registered while hosting');
  let settled = false;
  hosted.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settled, false, 'RPC held open while the process runs');
  boot.resolve({ ok: true });
  assert.deepEqual(await hosted, { ok: true });
  assert.equal(self._hostedProcesses.size, 0, 'host record cleared on exit');
  console.log('  case2: staged facet boots with coordinator-routed SUPERVISOR, RPC held open');
}

// ── (3) code: spec forwarded to the loader, residency outlives the boot ─
{
  const self = makeSelf();
  const codeBoot = {
    kind: 'code',
    code: {
      compatibilityDate: '2025-01-01',
      compatibilityFlags: ['nodejs_compat'],
      mainModule: 'worker.js',
      modules: { 'worker.js': 'export default {}' },
      vfsWasmModules: { 'ruby+stdlib.wasm': '/opt/ruby/ruby+stdlib.wasm' },
    },
  };
  const opts = { ...OPTS, workerKey: 'k-code', startContract: 'boot', startArgs: { userCode: 'puts 1' } };
  const hosted = _rpcHostProcess(self, codeBoot, opts);
  await new Promise((r) => setTimeout(r, 0));
  const boot = boots.at(-1);
  boot.resolve({ state: 'listening', port: 8080 });
  assert.deepEqual(await _rpcAwaitHostedBoot(self, 'k-code'), { payload: { state: 'listening', port: 8080 } });
  assert.deepEqual(
    boot.props.residentCode.vfsWasmModules,
    codeBoot.code.vfsWasmModules,
    'the image travels as a path for the loading entrypoint to resolve, not as bytes',
  );
  assert.deepEqual(boot.props.supervisor, {
    doId: 'coordinator-do-id',
    pid: 21,
    writerId: OPTS.writerId,
  });
  let settled = false;
  hosted.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settled, false, 'a boot-contract runner stays resident behind the held RPC');
  const routed = await _rpcRouteHostedHttp(self, 'k-code', {
    method: 'GET', url: 'http://x/doc', headers: [['accept', '*/*']], body: null,
  });
  assert.equal(routed.status, 200);
  assert.equal(await new Response(routed.body).text(), 'hosted /doc',
    'inbound HTTP resolves the running facet on this peer, body streamed as parts');
  assert.equal(_rpcCancelHostProcess(self, 'k-code').cancelled, true);
  assert.deepEqual(await hosted, { ok: true }, 'cancel ends the residency cleanly');
  console.log('  case3: code facet forwards its spec and stays resident past boot');
}

// ── (4) boot/route legs wait for the host leg rather than race it ───────
{
  const self = makeSelf();
  const routed = _rpcRouteHostedHttp(self, 'k-late', {
    method: 'GET', url: 'http://x/early', headers: [], body: null,
  });
  const hosted = _rpcHostProcess(self, STAGED_BOOT, { ...OPTS, workerKey: 'k-late' });
  assert.equal(await new Response((await routed).body).text(), 'hosted /early',
    'a request that beat the host leg is served, not dropped');
  _rpcCancelHostProcess(self, 'k-late');
  await assert.rejects(hosted, /stub disposed/);
  console.log('  case4: boot/route legs never race the host leg');
}

// ── (5) trust boundary: malformed opts / boot spec rejected before boot ─
{
  const before = boots.length;
  await assert.rejects(_rpcHostProcess(makeSelf(), STAGED_BOOT, { ...OPTS, coordinatorDoId: '' }));
  await assert.rejects(_rpcHostProcess(makeSelf(), STAGED_BOOT, { ...OPTS, pid: 0 }));
  await assert.rejects(_rpcHostProcess(makeSelf(), STAGED_BOOT, { ...OPTS, startContract: 'whenever' }));
  await assert.rejects(_rpcHostProcess(makeSelf(), { kind: 'staged', stage: { mode: 'attached' } }, OPTS));
  await assert.rejects(_rpcHostProcess(makeSelf(), { kind: 'code', code: { mainModule: 'worker.js' } }, OPTS));
  await assert.rejects(_rpcHostProcess(makeSelf(), { kind: 'elsewhere' }, OPTS));
  assert.equal(boots.length, before, 'no facet boot on invalid input');
  console.log('  case5: RPC trust boundary validates opts + boot spec');
}

// ── (6) cancel: releases the facet's resources → held RPC settles ───────
{
  const self = makeSelf();
  const hosted = _rpcHostProcess(self, STAGED_BOOT, { ...OPTS, workerKey: 'k-cancel' });
  await new Promise((r) => setTimeout(r, 0));
  const boot = boots.at(-1);
  assert.equal(_rpcCancelHostProcess(self, 'unknown-key').cancelled, false);
  assert.equal(_rpcCancelHostProcess(self, 'k-cancel').cancelled, true);
  await assert.rejects(hosted, /stub disposed/, 'held RPC settles so the coordinator observes the kill');
  assert.equal(boot.disposed, true, 'peer-side facet resources released');
  assert.equal(self._hostedProcesses.size, 0);
  assert.equal(_rpcCancelHostProcess(self, 'k-cancel').cancelled, false, 'cancel is idempotent');
  console.log('  case6: cancel tears the hosted facet down deterministically');
}

console.log('process-fabric-peer-leg: all cases passed');
