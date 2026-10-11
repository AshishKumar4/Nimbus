import assert from 'node:assert/strict';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';
import { rpcExec, rpcExecStream, rpcDetachExec } from '../../packages/worker/src/session/programmatic.ts';
import { collectExecStream, encodeExecStream } from '../../packages/core/src/runtime/exec-stream.ts';
import { programmaticHost } from './lib/programmatic-host.mjs';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';

const gates = new Map();
const gate = (name) => {
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const done = new Promise((resolve) => { release = resolve; });
  const value = { entered, enter, done, release };
  gates.set(name, value);
  return value;
};
const box = await programmaticHost({ commands: { async hold(ctx) {
  const held = gates.get(ctx.args[0]);
  held.enter();
  await held.done;
  await ctx.stdout.write('finished\n');
  return 7;
} } });
const { host, ws } = box;
const within = async (promise) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('named shell stayed busy after detach')), 5000); })]); }
  finally { clearTimeout(timer); }
};
const pending = [];
try {
  await rpcExec(host, 'cd /tmp; export KEPT=old', { shellId: 'agent' });
  const first = gate('first');
  const detach = new AbortController();
  const stream = await rpcExecStream(host, 'cd /home/user; export KEPT=detached; hold first', { shellId: 'agent', detach: detach.signal });
  const output = collectExecStream(stream);
  pending.push(output);
  await first.entered;
  detach.abort();
  assert.equal((await within(rpcExec(host, 'pwd; echo $KEPT; cd /home/user', { shellId: 'agent' }))).stdout, '/tmp\nold\n');
  first.release();
  assert.equal((await output).exitCode, 7, 'detach is not an exit or kill');
  assert.equal((await output).stdout, 'finished\n', 'the original output stream stays readable');
  assert.equal((await rpcExec(host, 'pwd; echo $KEPT', { shellId: 'agent' })).stdout, '/home/user\nold\n', 'the late completion cannot overwrite the next owner');

  // The SDK names the invocation without changing the process attribution.
  const sdkGate = gate('sdk');
  const asked = [];
  const stub = {
    _rpcReady: async () => ({ ok: true, preinstalled: [] }),
    _rpcExecStream: async (command, options) => { asked.push(options); return encodeExecStream(await rpcExecStream(host, command, options)); },
    _rpcDetachExec: async (id) => rpcDetachExec(host, id),
  };
  const sdk = Nimbus.fromEnv({ NIMBUS_SESSION: { idFromName: (name) => name, get: () => stub } }).sandbox('test', { shellId: 'agent' });
  const sdkDetach = new AbortController();
  const sdkStream = await sdk.execStream('hold sdk', { execId: 'user-attribution', detach: sdkDetach.signal });
  const sdkOutput = collectExecStream(sdkStream);
  pending.push(sdkOutput);
  await sdkGate.entered;
  assert.equal(asked.at(-1).execId, 'user-attribution');
  assert.equal(asked.at(-1).detach, undefined, 'an AbortSignal never crosses RPC');
  assert.notEqual(asked.at(-1).detachId, 'user-attribution');
  sdkDetach.abort();
  assert.equal((await within(sdk.exec('echo free'))).stdout, 'free\n');
  sdkGate.release();
  await sdkOutput;
  assert.deepEqual(rpcDetachExec(host, asked[0].detachId), { detached: false }, 'finished invocations are removed');

  // Before its turn: it keeps its place in the queue, then releases ownership
  // immediately upon entry, so it cannot hold the next command behind it.
  const blocker = gate('blocker'), queued = gate('queued');
  const blocked = collectExecStream(await rpcExecStream(host, 'hold blocker', { shellId: 'queued' }));
  pending.push(blocked);
  await blocker.entered;
  const queuedStream = rpcExecStream(host, 'cd /tmp; hold queued', { shellId: 'queued', detachId: 'queue-call' });
  assert.deepEqual(rpcDetachExec(host, 'queue-call', 'other'), { detached: false }, 'shell-scoped capability cannot detach another shell');
  assert.deepEqual(rpcDetachExec(host, 'queue-call', 'queued'), { detached: true });
  blocker.release();
  const queuedOutput = collectExecStream(await queuedStream);
  pending.push(queuedOutput);
  await queued.entered;
  assert.equal((await within(rpcExec(host, 'pwd', { shellId: 'queued' }))).stdout, '/home/user\n');
  queued.release();
  await queuedOutput;
  await blocked;

  // An already-fired signal crosses HTTP only after start acknowledges the
  // invocation, so detach cannot race ahead and answer "not found".
  const remoteGate = gate('remote');
  const remoteDetach = new AbortController();
  remoteDetach.abort();
  const remoteSdk = Nimbus.connect({ endpoint: 'https://detach.test', fetch: async (url, init) =>
    handleNimbusRemoteApi(new Request(url, init), { NIMBUS_SESSION: { idFromName: (name) => name, get: () => stub } }, { remote: { enabled: true, allowLegacy: true } }),
  }).sandbox('remote', { shellId: 'remote' });
  const remoteOutput = collectExecStream(await remoteSdk.execStream('hold remote', { detach: remoteDetach.signal }));
  pending.push(remoteOutput);
  await remoteGate.entered;
  assert.equal((await within(remoteSdk.exec('echo remote-free'))).stdout, 'remote-free\n');
  remoteGate.release();
  assert.equal((await remoteOutput).exitCode, 7);

  // A failed control RPC is not a command failure. Observe its report, then
  // let the original command exit normally and keep its output and exit code.
  const deniedGate = gate('denied');
  const denied = new AbortController();
  let reported;
  const heard = new Promise((resolve) => { reported = resolve; });
  const originalError = console.error;
  console.error = (message, error) => reported({ message, error });
  try {
    const failure = new Error('detach credentials expired');
    const deniedSdk = Nimbus.fromSession(() => ({ ...stub, _rpcDetachExec: async () => { throw failure; } })).sandbox('denied', { shellId: 'denied' });
    const deniedOutput = collectExecStream(await deniedSdk.execStream('hold denied', { detach: denied.signal }));
    pending.push(deniedOutput);
    await deniedGate.entered;
    denied.abort();
    const report = await within(heard);
    assert.match(report.message, /could not detach invocation/);
    assert.equal(report.error, failure);
    deniedGate.release();
    const completed = await deniedOutput;
    assert.equal(completed.exitCode, 7, 'exit still describes the actual command, not the control request');
    assert.equal(completed.stdout, 'finished\n');
  } finally { console.error = originalError; deniedGate.release(); }
} finally {
  for (const held of gates.values()) held.release();
  await Promise.allSettled(pending);
  await Promise.allSettled(box.held);
  await ws.close();
  box.close();
}
console.log('programmatic-detached-exec: shell ownership released, original process/output/exit retained');
