#!/usr/bin/env bun
// `box.files.as(cred)`: the SDK file plane bound to a credential.
//
// Over the DO binding — the colocated embedder, trusted with `cred` the way
// it is trusted with kernel writes — every method of the bound view hands
// the credential to the session's `_rpc*` method beside an undefined pid,
// and the unbound `box.files` hands nothing, so the default identity is
// untouched. Over the remote endpoint the credential survives into the RPC
// payload as an explicit trailing `{ cred }`, and the dispatcher answers it
// with the same refusal it gives `cred` on exec: a token authenticates a
// session, not a user inside it. Refused, never dropped — a remote caller is
// never told a read succeeded as an identity it did not ask for.

import assert from 'node:assert/strict';

import { Nimbus } from '../../packages/sdk/src/sandbox.ts';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';

const AGENT = Object.freeze({ uid: 4242, gid: 4242, groups: Object.freeze([4242]), umask: 0o022 });
const STAT = { type: 'file', size: 1, ctime: 0, atime: 0, mtime: 0, mode: 0o644, uid: 4242, gid: 4242 };

/** A NIMBUS_SESSION namespace whose stub records every file call it gets. */
function makeBinding(calls) {
  const record = (name) => async (...args) => {
    calls.push([name, ...args]);
    switch (name) {
      case '_rpcReadFile': return 'text';
      case '_rpcReadFileBytes': case '_rpcFsReadRange': return new Uint8Array([1]);
      case '_rpcWriteFile': return 1;
      case '_rpcStat': case '_rpcLstat': return STAT;
      case '_rpcReaddir': return [];
      case '_rpcExists': return true;
      default: return undefined;
    }
  };
  const stub = {
    _rpcReady: async () => ({ ok: true, preinstalled: [] }),
    _rpcReadFile: record('_rpcReadFile'),
    _rpcReadFileBytes: record('_rpcReadFileBytes'),
    _rpcWriteFile: record('_rpcWriteFile'),
    _rpcStat: record('_rpcStat'),
    _rpcLstat: record('_rpcLstat'),
    _rpcRename: record('_rpcRename'),
    _rpcChmod: record('_rpcChmod'),
    _rpcFsReadRange: record('_rpcFsReadRange'),
    _rpcReaddir: record('_rpcReaddir'),
    _rpcExists: record('_rpcExists'),
    _rpcMkdir: record('_rpcMkdir'),
    _rpcDeleteFile: record('_rpcDeleteFile'),
  };
  return { NIMBUS_SESSION: { idFromName: (name) => ({ name }), get: () => stub } };
}

// ── over the DO binding: the bound view carries the cred, the plain one does not ─
{
  const calls = [];
  const box = Nimbus.fromEnv(makeBinding(calls)).sandbox('s1');
  const mine = box.files.as(AGENT);

  await mine.read('/a');
  await mine.readBytes('/a');
  await mine.write('/a', 'x');
  await mine.stat('/a');
  await mine.lstat('/a');
  await mine.rename('/a', '/b');
  await mine.chmod('/b', 0o600);
  await mine.readRange('/b', 0, 1);
  await mine.list('/');
  await mine.mkdir('/d');
  await mine.exists('/d');
  await mine.delete('/d', { recursive: true });

  assert.deepEqual(calls, [
    ['_rpcReadFile', '/a', undefined, AGENT],
    ['_rpcReadFileBytes', '/a', undefined, AGENT],
    ['_rpcWriteFile', '/a', 'x', undefined, AGENT],
    ['_rpcStat', '/a', undefined, AGENT],
    ['_rpcLstat', '/a', undefined, AGENT],
    ['_rpcRename', '/a', '/b', undefined, AGENT],
    ['_rpcChmod', '/b', 0o600, undefined, AGENT],
    ['_rpcFsReadRange', '/b', 0, 1, undefined, AGENT],
    ['_rpcReaddir', '/', undefined, AGENT],
    ['_rpcMkdir', '/d', undefined, AGENT],
    ['_rpcExists', '/d', undefined, AGENT],
    ['_rpcDeleteFile', '/d', { recursive: true }, AGENT],
  ], 'every bound method hands the credential to the session beside an undefined pid');

  calls.length = 0;
  await box.files.read('/a');
  await box.files.write('/a', 'x');
  await box.files.delete('/a');
  assert.deepEqual(calls, [
    ['_rpcReadFile', '/a', undefined, undefined],
    ['_rpcWriteFile', '/a', 'x', undefined, undefined],
    ['_rpcDeleteFile', '/a', {}, undefined],
  ], 'the unbound plane names no credential — the default identity is untouched');

  const twice = mine.as({ ...AGENT, uid: 7 });
  calls.length = 0;
  await twice.read('/a');
  assert.equal(calls[0][3].uid, 7, 'as() rebinds; it does not accumulate');
  assert.equal(typeof box.files.as, 'function');
  assert.equal(typeof mine.as, 'function', 'the bound view is the same API, as() included');
}

// ── over the remote client: cred survives into the payload ────────────────
{
  const bodies = [];
  const fetchStub = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const { op } = bodies[bodies.length - 1];
    const result = op === 'ready' ? { ok: true, preinstalled: [] }
      : op === 'readFile' ? 'text'
      : op === 'writeFile' ? 1
      : op === 'stat' ? STAT
      : undefined;
    return new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });
  };
  const box = Nimbus.connect({ endpoint: 'https://nimbus.test', token: 't', fetch: fetchStub }).sandbox('s1');
  const mine = box.files.as(AGENT);
  await mine.read('/a');
  await mine.write('/a', 'x');
  await mine.stat('/a');
  await mine.readRange('/a', 0, 1).catch(() => {});
  await mine.delete('/a', { recursive: true });
  const ops = Object.fromEntries(bodies.filter((b) => b.op !== 'ready').map((b) => [b.op, b.args]));
  assert.deepEqual(ops.readFile, ['/a', { cred: AGENT }], 'readFile carries the cred as a trailing options object');
  assert.deepEqual(ops.writeFile, ['/a', 'x', { cred: AGENT }]);
  assert.deepEqual(ops.stat, ['/a', { cred: AGENT }]);
  assert.deepEqual(ops.readRange, ['/a', 0, 1, { cred: AGENT }]);
  assert.deepEqual(ops.deleteFile, ['/a', { recursive: true, cred: AGENT }], 'deleteFile folds it into its options');

  bodies.length = 0;
  await box.files.read('/a');
  await box.files.delete('/a');
  assert.deepEqual(bodies.filter((b) => b.op !== 'ready').map((b) => b.args), [['/a'], ['/a', {}]], 'unbound, the wire is what it always was');
}

// ── and the remote dispatcher refuses it, before the session is asked ─────
{
  const reached = [];
  const env = {
    NIMBUS_SESSION: {
      idFromName: (name) => ({ name }),
      get: () => ({
        _rpcReadFile: async (...args) => { reached.push(['readFile', ...args]); return 'text'; },
        _rpcDeleteFile: async (...args) => { reached.push(['deleteFile', ...args]); },
        _rpcWriteFile: async (...args) => { reached.push(['writeFile', ...args]); return 1; },
      }),
    },
  };
  const call = (op, args) => handleNimbusRemoteApi(
    new Request('https://example.test/api/nimbus/v1/sandboxes/s1/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args }),
    }),
    env,
    { remote: { enabled: true, allowLegacy: true } },
  );

  for (const [op, args] of [
    ['readFile', ['/a', { cred: AGENT }]],
    ['writeFile', ['/a', 'x', { cred: AGENT }]],
    ['deleteFile', ['/a', { recursive: true, cred: AGENT }]],
  ]) {
    const refused = await call(op, args);
    assert.equal(refused.status, 400, `${op}: a remote caller naming a uid is refused`);
    const body = await refused.json();
    assert.equal(body.code, 'E_ARG_SHAPE');
    assert.match(body.error, /cred is not accepted over the remote API/);
  }
  assert.deepEqual(reached, [], 'the refusal happens before the session is asked');

  // Refused, not dropped: the plain ops still go through untouched.
  assert.equal((await call('readFile', ['/a'])).status, 200);
  assert.equal((await call('deleteFile', ['/a', { recursive: true }])).status, 200);
  assert.deepEqual(reached, [['readFile', '/a'], ['deleteFile', '/a', { recursive: true }]], 'and reach the session with no credential');
}

console.log('PASS sdk-files-as-credential');
