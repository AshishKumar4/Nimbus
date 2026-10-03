#!/usr/bin/env bun
// A filesystem refusal crosses SupervisorRPC as a value (Kinu ask 16).
//
// A read the host refuses was thrown on from the loopback entrypoint, and
// the platform recorded every such invocation as outcome "exception", "The
// Workers runtime canceled this request because it detected that your
// Worker's code had hung", though its caller was answered at once. What has
// to hold:
//
//   (1) SupervisorRPC.answer resolves a refused filesystem call with the
//       refusal as a value, so no exception leaves the entrypoint; a call
//       that succeeds resolves with its value, and a failure without a code
//       (a dropped connection, a bug) still throws;
//   (2) the facet's client (answeringSupervisor) rethrows each refusal as
//       exactly the error the facet received when SupervisorRPC threw it:
//       its class, name, message and own properties (code, errno, syscall,
//       path, dest, detail, cause), and hands a success on unchanged;
//   (3) the filesystem codec the WASI and bash runners share
//       (supervisorFilesystem) makes its calls through `answer`, and a
//       same-isolate supervisor is used as it is.
//
// Both workerd hops (session → SupervisorRPC, SupervisorRPC → facet) are
// modeled by lib/rpc-error.mjs's acrossRpc; fs-error-shapes-cross-workerd
// checks the same through the real workerd.

import assert from 'node:assert/strict';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import {
  answeringSupervisor,
  FILESYSTEM_RPC_METHODS,
  SUPERVISOR_ANSWERED_METHODS,
  supervisorFilesystem,
  vfsSupervisor,
} from '../../packages/core/src/runtime/vfs-supervisor.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { acrossRpc } from './lib/rpc-error.mjs';

const build = await Bun.build({
  entrypoints: ['supervisor-refusal-entry'],
  target: 'bun',
  plugins: [{
    name: 'supervisor-entrypoint',
    setup(builder) {
      builder.onResolve({ filter: /^supervisor-refusal-entry$/ }, () => ({ path: 'entry', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, (args) => args.path === 'entry'
        ? {
            contents: 'export { SupervisorRPC } from '
              + JSON.stringify(new URL('../../packages/worker/src/session/supervisor-rpc.ts', import.meta.url).pathname) + ';',
            loader: 'js',
          }
        : { contents: 'export class WorkerEntrypoint {}', loader: 'js' });
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'test' }));
    },
  }],
});
assert.equal(build.success, true, build.logs.map(String).join('\n'));
const { SupervisorRPC } = await import('data:text/javascript;base64,' + Buffer.from(await build.outputs[0].text()).toString('base64'));

// The session: a real filesystem and the session's real supervisor ops.
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernelVfs = rawVfs.as(CRED_KERNEL);
kernelVfs.mkdir('home/user', { recursive: true });
kernelVfs.chown('home', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
kernelVfs.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
const sessionFs = rawVfs.as(CRED_SESSION_USER);
sessionFs.writeFile('home/user/file', 'seeded\n');
sessionFs.mkdir('home/user/full/inner', { recursive: true });
kernelVfs.mkdir('home/root-only');
const processes = new SessionProcessSupervisor();
const pid = processes.spawn('probe', ['probe'], '/').pid;
const ops = buildSessionSupervisorOps({
  sqliteFs: rawVfs,
  processes,
  ensureSqliteFs() {},
  _rpcStdout() {},
  _rpcStderr() {},
});

/** SupervisorRPC as the platform serves it: a fresh instance per call, the session one hop away. */
function entrypoint(props = { doId: 'host-id', pid, writerId: 'writer' }) {
  const supervisor = Object.create(SupervisorRPC.prototype);
  supervisor.ctx = { props: { ...props, route: { supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'HOST', hostDispatchMethod: 'supervisorOp' } } };
  supervisor.env = {
    HOST: {
      idFromName: (name) => name,
      idFromString: (value) => value,
      get: () => ({
        // Hop 1: the session's refusal crosses to the entrypoint.
        async supervisorOp(envelope) {
          try { return structuredClone(await ops.dispatch(envelope)); }
          catch (error) { throw acrossRpc(error); }
        },
      }),
    },
  };
  return supervisor;
}

/**
 * The SUPERVISOR binding as a facet holds it: every name is a method (an RPC
 * stub's are), each call a fresh entrypoint, and hop 2 crossed back: a value
 * cloned, a throw as acrossRpc delivers it. `calls` records the methods the
 * facet called on the stub.
 */
function facetBinding(props) {
  const calls = [];
  const stub = new Proxy({}, {
    get(_, name) {
      if (typeof name !== 'string') return undefined;
      return async (...args) => {
        calls.push(name);
        try { return structuredClone(await entrypoint(props)[name](...args)); }
        catch (error) { throw acrossRpc(error); }
      };
    },
  });
  return { stub, calls };
}

/** Bun's own additions to an error, which workerd's errors do not have and its hops do not compare. */
const BUN_ERROR_KEYS = new Set(['line', 'column', 'originalLine', 'originalColumn', 'sourceURL']);

/** Everything a program can observe of an error but its stack. */
function observed(error) {
  const own = {};
  for (const key of Reflect.ownKeys(error)) {
    if (key === 'stack' || BUN_ERROR_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    own[String(key)] = { value: descriptor.value instanceof Error ? observed(descriptor.value) : descriptor.value, enumerable: descriptor.enumerable };
  }
  return { class: Object.getPrototypeOf(error).constructor.name, name: error.name, message: error.message, own };
}

async function outcome(promise) {
  try { return { value: await promise }; }
  catch (error) { return { error: observed(error) }; }
}

const REFUSED = [
  ['stat', ['/home/user/file/child']],
  ['readFileBytes', ['/home/user/full']],
  ['readdir', ['/home/user/file']],
  ['writeFile', ['/home/user/missing/f', 'x']],
  ['mkdir', ['/home/user/file']],
  ['rmdir', ['/home/user/full']],
  ['unlink', ['/home/user/full']],
  ['rename', ['/home/user/nope', '/home/user/elsewhere']],
  ['access', ['/home/user/nope', 0]],
  ['fsOpen', ['/home/user/nope', { read: true }]],
  ['fsReadRange', ['/home/user/full', 0, 4]],
  ['mkdir', ['/home/root-only/sub']],
];

// ── (1) the entrypoint answers a refusal; nothing leaves it as an exception ─
const notRefused = [];
for (const [method, args] of REFUSED) {
  const answer = await entrypoint().answer(method, args);
  if (!('refusal' in answer)) { notRefused.push(`${method} ${JSON.stringify(answer)}`); continue; }
  assert.ok('refusal' in answer, `${method}(${args[0]}) was answered with its refusal: ${JSON.stringify(answer)}`);
  assert.equal(typeof answer.refusal.properties.code, 'string', `${method}: the refusal carries its code`);
}
assert.deepEqual(notRefused, [], 'every case is a refusal');
assert.deepEqual(await entrypoint().answer('stat', ['/home/user/file']).then((a) => a.value.type), 'file', 'a success is the value');
await assert.rejects(entrypoint({ doId: 'host-id', writerId: 'writer' }).answer('stat', ['/home/user/file']),
  /missing or invalid process pid/, 'a failure with no code still throws');
await assert.rejects(entrypoint().answer('cpSpawn', [{}]), TypeError, 'answer runs only the filesystem surface');
for (const method of SUPERVISOR_ANSWERED_METHODS) {
  assert.equal(typeof SupervisorRPC.prototype[method], 'function', `${method} is a SupervisorRPC method`);
}
// One source of truth: every call the bridge makes is answered but the
// streamed write, whose stream does not travel inside an argument list.
for (const method of Object.values(FILESYSTEM_RPC_METHODS)) {
  assert.equal(SUPERVISOR_ANSWERED_METHODS.includes(method), method !== FILESYSTEM_RPC_METHODS.writeStream, method);
}
assert.equal(new Set(SUPERVISOR_ANSWERED_METHODS).size, SUPERVISOR_ANSWERED_METHODS.length, 'no method is listed twice');

// ── (2) the client rethrows exactly what the throw delivered ────────────────
for (const [method, args] of REFUSED) {
  const thrown = await outcome(facetBinding().stub[method](...args));
  const answered = facetBinding();
  const rethrown = await outcome(answeringSupervisor(answered.stub)[method](...args));
  assert.ok(thrown.error, `${method}(${args[0]}) is refused`);
  assert.deepEqual(rethrown, thrown, `${method}(${args[0]}): the facet sees the error it saw when the entrypoint threw`);
  assert.deepEqual(answered.calls, ['answer'], `${method} went through answer`);
}
// Refusals of every shape a host can raise: a named error class with a cause
// and detail, a standard class, a second path.
{
  const shapes = {
    '/named': Object.assign(new Error('EACCES: refused by policy', { cause: new RangeError('quota') }), { name: 'MountRefusal', code: 'EACCES', detail: { mount: '/pc' } }),
    '/standard': Object.assign(new TypeError('path must be a string'), { code: 'ERR_INVALID_ARG_TYPE' }),
    '/two-paths': Object.assign(new Error("EXDEV: cross-device link not permitted, rename '/a' -> '/b'"), { code: 'EXDEV', errno: -18, syscall: 'rename', path: '/a', dest: '/b' }),
  };
  const refusing = (props) => {
    const supervisor = entrypoint(props);
    supervisor.env.HOST.get = () => ({
      async supervisorOp(envelope) { throw acrossRpc(shapes[envelope.args[0]]); },
    });
    return supervisor;
  };
  const binding = () => new Proxy({}, {
    get: (_, name) => typeof name === 'string'
      ? async (...args) => {
          try { return structuredClone(await refusing()[name](...args)); }
          catch (error) { throw acrossRpc(error); }
        }
      : undefined,
  });
  for (const path of Object.keys(shapes)) {
    const thrown = await outcome(binding().stat(path));
    const rethrown = await outcome(answeringSupervisor(binding()).stat(path));
    assert.ok(thrown.error, path);
    assert.deepEqual(rethrown, thrown, `${path}: the facet sees the error it saw when the entrypoint threw`);
  }
  assert.equal((await outcome(answeringSupervisor(binding()).stat('/named'))).error.own.detail.value.mount, '/pc', 'detail survives');
}
{
  const thrown = await outcome(facetBinding().stub.readFileBytes('/home/user/file'));
  const rethrown = await outcome(answeringSupervisor(facetBinding().stub).readFileBytes('/home/user/file'));
  assert.deepEqual(rethrown, thrown, 'a success is handed on unchanged');
  assert.ok(rethrown.value instanceof Uint8Array);
}
{
  const props = { doId: 'host-id', writerId: 'writer' };
  const thrown = await outcome(facetBinding(props).stub.stat('/home/user/file'));
  const rethrown = await outcome(answeringSupervisor(facetBinding(props).stub).stat('/home/user/file'));
  assert.match(thrown.error.message, /missing or invalid process pid/);
  assert.deepEqual(rethrown, thrown, 'a failure with no code reaches the facet as it did');
}
// Names the client does not answer are the stub's own.
{
  const { stub, calls } = facetBinding();
  await answeringSupervisor(stub).stdout(new Uint8Array([104, 105]));
  assert.deepEqual(calls, ['stdout']);
}

// ── (3) the WASI and bash codec answers; a local supervisor is used as is ──
{
  const { stub, calls } = facetBinding();
  await assert.rejects(supervisorFilesystem(stub).stat('/home/user/file/child'), (error) => error.code === 'ENOTDIR');
  assert.equal(new TextDecoder().decode(await supervisorFilesystem(stub).readFile('/home/user/file')), 'seeded\n');
  assert.deepEqual(calls, ['answer', 'answer'], 'the codec reached the filesystem through answer');
  const local = vfsSupervisor({ stat: () => { throw Object.assign(new Error('ENOENT: local'), { code: 'ENOENT' }); } });
  assert.equal(answeringSupervisor(local), local, 'a same-isolate supervisor has no answer and is used as it is');
}

console.log('ok - supervisor-refusal-answer (refusals answered as values, rethrown exactly, codec answers)');
