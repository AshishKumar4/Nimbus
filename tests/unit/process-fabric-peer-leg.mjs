#!/usr/bin/env bun
// process-fabric-peer-leg — the peer-DO host leg of the heavy-process
// scheduler must:
//   (1) answer the placement probe with the module-scope isolate token;
//   (2) boot the staged process from the PEER's NimbusLoadedEntrypoint with
//       the SUPERVISOR routed to the COORDINATOR's doId (never the peer's),
//       holding the RPC open until the process lifecycle ends;
//   (3) validate the host opts / stage spec at the RPC trust boundary;
//   (4) tear the hosted facet down on _rpcCancelHostProcess (the peer-side
//       equivalent of FacetManager.kill's stub disposal).

import assert from 'node:assert/strict';
import {
  _rpcHostProcessProbe,
  _rpcHostProcess,
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
const OPTS = { coordinatorDoId: 'coordinator-do-id', pid: 21, workerKey: 'nimbus-process:coordinator-do-id:21' };

// Peer-side NimbusLoadedEntrypoint mock: startProcess resolves when the test
// releases it; the stub's Symbol.dispose (what disposeRpcResource invokes)
// rejects it — mirroring workerd severing a held-open loopback RPC.
const boots = [];
setCtxExports({
  NimbusLoadedEntrypoint(options) {
    const boot = { props: options.props, disposed: false };
    boot.lifecycle = new Promise((resolve, reject) => {
      boot.resolve = resolve;
      boot.rejectAsDisposed = () => reject(new Error('stub disposed'));
    });
    boots.push(boot);
    return {
      startProcess: () => boot.lifecycle,
      [Symbol.dispose]() {
        boot.disposed = true;
        boot.rejectAsDisposed();
      },
    };
  },
});

function makeSelf() {
  return { _hostedProcessCancels: new Map() };
}

// ── (1) probe returns the module-scope isolate token ────────────────────
{
  const probe = _rpcHostProcessProbe(makeSelf());
  assert.equal(probe.isolateToken, isolateToken(), 'probe reports this isolate/process identity');
  assert.equal(_rpcHostProcessProbe(makeSelf()).isolateToken, probe.isolateToken, 'token is stable');
  console.log('  case1: placement probe returns the stable isolate token');
}

// ── (2) host: peer boots the facet, SUPERVISOR routed to the coordinator ─
{
  const self = makeSelf();
  const hosted = _rpcHostProcess(self, STAGE, OPTS);
  await new Promise((r) => setTimeout(r, 0));
  const boot = boots.at(-1);
  assert.deepEqual(
    boot.props.supervisor,
    { doId: 'coordinator-do-id', pid: 21 },
    'syscalls route to the COORDINATOR, not this peer',
  );
  assert.equal(boot.props.key, OPTS.workerKey);
  assert.deepEqual(boot.props.stage, STAGE, 'validated stage spec forwarded to the assembler');
  assert.equal(self._hostedProcessCancels.size, 1, 'cancel hook registered while hosting');
  let settled = false;
  hosted.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(settled, false, 'RPC held open while the process runs');
  boot.resolve({ ok: true });
  assert.deepEqual(await hosted, { ok: true });
  assert.equal(self._hostedProcessCancels.size, 0, 'cancel hook cleared on exit');
  console.log('  case2: hosted facet boots with coordinator-routed SUPERVISOR, RPC held open');
}

// ── (3) trust boundary: malformed opts / stage rejected before any boot ─
{
  const before = boots.length;
  await assert.rejects(_rpcHostProcess(makeSelf(), STAGE, { coordinatorDoId: '', pid: 1, workerKey: 'k' }));
  await assert.rejects(_rpcHostProcess(makeSelf(), STAGE, { coordinatorDoId: 'c', pid: 0, workerKey: 'k' }));
  await assert.rejects(_rpcHostProcess(makeSelf(), { mode: 'attached' }, OPTS)); // truncated stage
  assert.equal(boots.length, before, 'no facet boot on invalid input');
  console.log('  case3: RPC trust boundary validates opts + stage');
}

// ── (4) cancel: disposes the held startProcess stub → RPC settles ───────
{
  const self = makeSelf();
  const hosted = _rpcHostProcess(self, STAGE, { ...OPTS, workerKey: 'k-cancel' });
  await new Promise((r) => setTimeout(r, 0));
  const boot = boots.at(-1);
  assert.equal(_rpcCancelHostProcess(self, 'unknown-key').cancelled, false);
  assert.equal(_rpcCancelHostProcess(self, 'k-cancel').cancelled, true);
  assert.equal(boot.disposed, true, 'peer-side startProcess stub disposed');
  await assert.rejects(hosted, /stub disposed/, 'held RPC settles so the coordinator observes the kill');
  assert.equal(self._hostedProcessCancels.size, 0);
  assert.equal(_rpcCancelHostProcess(self, 'k-cancel').cancelled, false, 'cancel is idempotent');
  console.log('  case4: cancel tears the hosted facet down deterministically');
}

console.log('process-fabric-peer-leg: all cases passed');
