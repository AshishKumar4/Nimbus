#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { SUPERVISOR_OP_ROUTES, SUPERVISOR_NATIVE_OPS } from '../../packages/core/src/workspace/supervisor-op.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { dec } from '../../packages/core/src/_shared/bytes.ts';

const build = await Bun.build({
  // A virtual entry re-exports the real entrypoint AND composeFabric, so the
  // bundle's composition state is the one the test configures — a data: URL
  // cannot share module instances with this file.
  entrypoints: ['supervisor-host-dispatch-entry'],
  target: 'bun',
  plugins: [{
    name: 'supervisor-entrypoint-host',
    setup(builder) {
      builder.onResolve({ filter: /^supervisor-host-dispatch-entry$/ }, () => ({ path: 'entry', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, (args) => args.path === 'entry'
        ? {
            contents:
              'export { SupervisorRPC } from ' +
              JSON.stringify(new URL('../../packages/worker/src/session/supervisor-rpc.ts', import.meta.url).pathname) +
              '; export { composeFabric } from ' +
              JSON.stringify(new URL('../../packages/platform/src/composition.ts', import.meta.url).pathname) + ';',
            loader: 'js',
          }
        : { contents: 'export class WorkerEntrypoint {}', loader: 'js' });
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'test' }));
      builder.onResolve({ filter: /^@nimbus-sh\/platform\/composition\.js$/ }, () => ({
        // Bundled, not external: a bare specifier inside a data: URL module
        // has nothing to resolve against.
        path: new URL('../../packages/platform/src/composition.ts', import.meta.url).pathname,
      }));
    },
  }],
});
assert.equal(build.success, true, build.logs.map(String).join('\n'));
const bundle = await import('data:text/javascript;base64,' + Buffer.from(await build.outputs[0].text()).toString('base64'));
const { SupervisorRPC, composeFabric: bundleComposeFabric } = bundle;
bundleComposeFabric({ supervisorEntrypoint: 'Supervisor', hostNamespace: 'HOSTS', hostDispatchMethod: 'dispatchWorkspace' });

// A real filesystem the native ops can actually run against — the session
// handler's native ops are the production implementation, so a stub that
// recorded calls would be testing the test. The fixture lives under
// /home/user, which the session user owns.
const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernelVfs = rawVfs.as(CRED_KERNEL);
kernelVfs.mkdir('home/user', { recursive: true });
kernelVfs.chown('home', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
kernelVfs.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
kernelVfs.symlink('file', 'home/user/link');

const processes = new SessionProcessSupervisor();
const pid = processes.spawn('probe', ['probe'], '/').pid;
const writerId = 'writer', mutationOwner = 'lease';
// The fs ops mutate, so every one gets its own path — a shared fixture would
// make the table's order load-bearing.
const path = '/home/user/file', from = '/home/user/ren', to = '/home/user/ren2';
const target = '/home/user/file', symlinkPath = '/home/user/link2';
const wPath = '/home/user/w', dirPath = '/home/user/dir', delPath = '/home/user/del';
const linkPath = '/home/user/link';
const chmodPath = '/home/user/chmod', utimesPath = '/home/user/utimes', truncPath = '/home/user/trunc';
const sessionFs = rawVfs.as(CRED_SESSION_USER);
sessionFs.writeFile('home/user/ren', 'x');
sessionFs.writeFile('home/user/del', 'x');
sessionFs.writeFile('home/user/chmod', 'x');
sessionFs.writeFile('home/user/utimes', 'x');
sessionFs.writeFile('home/user/trunc', 'truncate me');
sessionFs.writeFile('home/user/file', 'seeded\n');
const bytes = new Uint8Array([1, 2, 3]), content = 'written';
const atimeMs = 100, mtimeMs = 200, mode = 0o640, size = 3;
const uid = CRED_SESSION_USER.uid, gid = CRED_SESSION_USER.gid;
const mask = 0o077;
const options = { followSymlinks: false }, epoch = 'epoch', cursor = 9, after = 'after', limit = 32;
const url = 'https://remote.test/', protocols = ['protocol'], id = 7, waitMs = 25, text = 'text';
const code = 0, reason = 'closed', flags = 'r', handleId = 4, offset = 0, length = 3;
const requests = [{ path, offset, length }], moduleId = 'module', operationId = 'operation';
const payload = { inodes: [], chunks: [] }, stream = encodeWriteBatchStream({ inodes: [], chunks: [] });
const entries = [], data = 'output', tail = 'tail', cwd = '/cwd', entryCode = 'export {}', port = 8080;
const request = new Request('https://loopback.test/'), loader = 'js', req = { parentPid: 999, command: 'cat' };
const childPid = 42, fd = 1, sinceSeq = 3, signal = 'SIGTERM', kind = 'pure-builtin';
const INPUTS = {
  readFile: [path],
  readFileBytes: [path],
  writeFile: [wPath, content],
  stat: [path],
  lstat: [linkPath],
  hasLegacySymlinkUnder: [path],
  utimes: [utimesPath, atimeMs, mtimeMs],
  chmod: [chmodPath, mode],
  access: [path, mode],
  chown: [path, uid, gid, options],
  setUmask: [mask],
  readdir: ['/home/user'],
  exists: [path],
  mkdir: [dirPath],
  rmdir: [dirPath],
  rename: [from, to],
  unlink: [delPath],
  readlink: [linkPath],
  symlink: [target, symlinkPath],
  fsAcquire: [epoch, cursor],
  fsRevision: [path],
  fsList: [after, limit],
  wsOpen: [url, protocols],
  wsPoll: [id, waitMs],
  wsSend: [id, text, bytes],
  wsClose: [id, code, reason],
  fsOpen: [path, flags],
  fsRead: [handleId, offset, length],
  fsWrite: [handleId, offset, bytes],
  fsClose: [handleId],
  fsReadRange: [path, offset, length],
  fsReadRangeUncached: [path, offset, length],
  fsReadBatch: [requests],
  fsWriteRange: [path, offset, bytes],
  fsAppend: [path, moduleId, operationId, bytes],
  fsAppendAck: [moduleId, operationId],
  fsTruncate: [truncPath, size],
  writeBatch: [payload],
  writeBatchStream: [stream],
  putRegistryEntries: [entries],
  stdout: [data],
  stderr: [data],
  reportExit: [code, tail],
  prefetch: [cwd, entryCode],
  registerPort: [port],
  unregisterPort: [port],
  routeLoopback: [port, request],
  transform: [code, loader],
  cpSpawn: [req],
  cpStdinWrite: [childPid, data],
  cpStdinEnd: [childPid],
  cpReadStdin: [childPid, waitMs],
  cpReadOutput: [childPid, fd, sinceSeq, waitMs],
  cpDrainOutput: [childPid],
  cpKill: [childPid, signal],
  cpWait: [childPid, waitMs],
  cpDispatchInline: [req, kind],
};

// The props the supervisor binding stamps — the envelope's identity fields
// every arg spec reads from.
const PROPS = { pid, writerId, mutationOwner, stream };

// Cases derive from the canonical table: the delegate is route.method, the
// expected arguments are the mapped envelope slots — the only op whose input
// isn't its envelope args is cpSpawn (the RPC rewrites parentPid).
const cases = Object.entries(SUPERVISOR_OP_ROUTES).map(([op, route]) => {
  const input = INPUTS[op];
  // writeBatchStream's stream rides the envelope field, not args.
  const envelopeArgs = op === 'writeBatchStream' ? [] : (input ?? []);
  // cpSpawn rewrites parentPid before the envelope is built.
  const sentArgs = op === 'cpSpawn' ? [{ ...req, parentPid: pid }] : envelopeArgs;
  const expected = op === 'cpSpawn'
    ? [{ ...req, parentPid: pid }]
    : route.args.map((slot) => typeof slot === 'number' ? envelopeArgs[slot] : PROPS[slot]);
  return [op, input, envelopeArgs, sentArgs, route.method, expected];
});

// Every fixture names a real op; every real op has a fixture.
assert.deepEqual(Object.keys(INPUTS).sort(), Object.keys(SUPERVISOR_OP_ROUTES).sort(),
  'INPUTS and the canonical table name the same ops');

// The session's supervisor handler, on the session's real filesystem. The
// host delegates — _rpcStdout/_rpcStderr and every routed non-fs op — are
// stubs that capture their arguments.
const delegateCalls = [];
const host = {
  sqliteFs: rawVfs,
  processes,
  ensureSqliteFs() {},
  _rpcStdout(p, d) { delegateCalls.push(['_rpcStdout', p, d]); },
  _rpcStderr(p, d) { delegateCalls.push(['_rpcStderr', p, d]); },
};
for (const [op, , , , method, expected] of cases) {
  if (!SUPERVISOR_NATIVE_OPS.has(op)) {
    host[method] = (...args) => { delegateCalls.push([method, ...args]); return Promise.resolve({ value: 'answer' }); };
  }
}
const ops = buildSessionSupervisorOps(host);

const supervisor = Object.create(SupervisorRPC.prototype);
supervisor.ctx = { props: { doId: 'host-id', pid, writerId, mutationOwner } };
let receivedEnvelope;
const stub = {
  dispatchWorkspace(envelope) {
    assert.equal(this, stub, 'RPC dispatch keeps the stub receiver');
    receivedEnvelope = envelope;
    return ops.dispatch(envelope);
  },
};
supervisor.env = {
  HOSTS: {
    idFromString(value) { assert.equal(value, 'host-id'); return value; },
    get(value) { assert.equal(value, 'host-id'); return stub; },
  },
};

// Native ops run the real implementation — what they return IS the
// assertion; everything else is a captured delegate call.
const nativeAssert = {
  readFile: (r) => assert.equal(r, 'seeded\n', 'readFile'),
  readFileBytes: (r) => assert.deepEqual(Array.from(r), Array.from(new TextEncoder().encode('seeded\n')), 'readFileBytes'),
  writeFile: async () => assert.equal(dec.decode(kernelVfs.readFile('home/user/w')), content, 'writeFile persisted'),
  stat: (r) => assert.equal(r.type, 'file', 'stat'),
  lstat: (r) => assert.equal(r.type, 'symlink', 'lstat'),
  hasLegacySymlinkUnder: (r) => assert.equal(r, false, 'hasLegacySymlinkUnder'),
  utimes: async () => assert.equal((kernelVfs.stat('home/user/utimes')).mtime > 0, true, 'utimes applied'),
  chmod: async () => assert.equal(kernelVfs.stat('home/user/chmod').mode & 0o777, mode, 'chmod applied'),
  exists: (r) => assert.equal(r, true, 'exists'),
  readdir: (r) => assert.ok(r.some((e) => e.name === 'file'), 'readdir sees the fixture'),
  rename: async () => assert.equal(dec.decode(kernelVfs.readFile('home/user/ren2')), 'x', 'rename moved'),
  mkdir: async () => assert.equal(kernelVfs.isDirectory('home/user/dir'), true, 'mkdir created'),
  rmdir: async () => assert.equal(kernelVfs.exists('home/user/dir'), false, 'rmdir removed'),
  unlink: async () => assert.equal(kernelVfs.exists('home/user/del'), false, 'unlink removed'),
  readlink: (r) => assert.equal(r, 'file', 'readlink resolves the link'),
  symlink: async () => assert.equal(dec.decode(kernelVfs.readFile('home/user/link2')), 'seeded\n', 'symlink target reads'),
  fsReadRange: (r) => assert.deepEqual(Array.from(r), Array.from(new TextEncoder().encode('see')), 'fsReadRange'),
  fsReadRangeUncached: (r) => assert.deepEqual(Array.from(r), Array.from(new TextEncoder().encode('see')), 'fsReadRangeUncached'),
  fsRevision: (r) => assert.equal(typeof r, 'number', 'fsRevision'),
  fsTruncate: async () => assert.equal(kernelVfs.readFile('home/user/trunc').length, size, 'fsTruncate sized'),
  writeBatchStream: (r) => assert.ok(r && typeof r === 'object', 'writeBatchStream returned its result'),
  stdout: () => assert.deepEqual(delegateCalls.at(-1), ['_rpcStdout', pid, data], 'stdout delegate args'),
  stderr: () => assert.deepEqual(delegateCalls.at(-1), ['_rpcStderr', pid, data], 'stderr delegate args'),
};

for (const [op, input, envelopeArgs, sentArgs, delegate, expected] of cases) {
  let disposed = 0;
  const answer = op === 'routeLoopback' ? new Response('streamed body') : { value: 'answer' };
  answer[Symbol.dispose] = () => disposed++;
  if (!SUPERVISOR_NATIVE_OPS.has(op)) {
    host[delegate] = (...args) => { delegateCalls.push([delegate, ...args]); return Promise.resolve(answer); };
  }
  const result = await supervisor[op](...input);
  assert.equal(receivedEnvelope.op, op);
  // The envelope's args must carry the RPC's inputs — the route's numeric
  // slots are indexes into this array, so a dropped arg is a dropped arg.
  assert.deepEqual(receivedEnvelope.args, sentArgs, `${op}: envelope args`);
  if (op === 'writeBatchStream') assert.equal(receivedEnvelope.stream, stream);
  if (SUPERVISOR_NATIVE_OPS.has(op)) {
    await nativeAssert[op](result);
  } else {
    // Routed to the session's _rpc* surface — the captured call is the
    // contract the canonical table names, and the response is disposed once
    // the RPC is done with it (routeLoopback's body streams on).
    assert.deepEqual(delegateCalls.at(-1), [delegate, ...expected], `${op}: delegate args`);
    assert.equal(result, answer, op);
    assert.equal(disposed, op === 'routeLoopback' ? 0 : 1, `${op}: response lifetime`);
    if (op === 'routeLoopback') assert.equal(await answer.text(), 'streamed body');
  }
}

// An op the table does not name is not served — on any host.
for (const op of ['constructor', 'toString', '_rpcInnerDoFetch', 'missing']) {
  await assert.rejects(ops.dispatch({ op }), /not served/);
}
supervisor.ctx.props.pid = 0;
await assert.rejects(supervisor.writeFile('/a', 'bad'), /invalid process pid/);
await assert.rejects(supervisor.cpSpawn({ parentPid: 999 }), /invalid process pid/);
supervisor.ctx.props.pid = pid;
supervisor.ctx.props.writerId = '';
await assert.rejects(supervisor.fsAppend('/a', 'm', 'op', bytes), /writer incarnation/);
supervisor.ctx.props.doId = '';
await assert.rejects(supervisor.readFile('/a'), /missing doId/);
supervisor.ctx.props.doId = 'host-id';
supervisor.env = {};
await assert.rejects(supervisor.readFile('/a'), /not a Durable Object namespace/);
console.log(`supervisor-host-dispatch: ${cases.length} routes preserve arguments, identity and response lifetimes`);
