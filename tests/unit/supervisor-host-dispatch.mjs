#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { sessionSupervisorOp } from '../../packages/worker/src/session/supervisor-op.ts';
import { SUPERVISOR_OPS } from '../../packages/core/src/workspace/supervisor-op.ts';

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
const pid = 23, writerId = 'writer', mutationOwner = 'lease';
const path = '/file', from = '/from', to = '/to', target = '/target';
const bytes = new Uint8Array([1, 2, 3]), content = bytes;
const atimeMs = 100, mtimeMs = 200, mode = 0o640, uid = 1000, gid = 1000, mask = 0o077;
const options = { followSymlinks: false }, epoch = 'epoch', cursor = 9, after = 'after', limit = 32;
const url = 'https://remote.test/', protocols = ['protocol'], id = 7, waitMs = 25, text = 'text';
const code = 0, reason = 'closed', flags = 'r', handleId = 4, offset = 1, length = 3;
const requests = [{ path, offset, length }], moduleId = 'module', operationId = 'operation', size = 3;
const payload = { inodes: [], chunks: [] }, stream = new ReadableStream({ start(c) { c.close(); } });
const entries = [], data = 'output', tail = 'tail', cwd = '/cwd', entryCode = 'export {}', port = 8080;
const request = new Request('https://loopback.test/'), loader = 'js', req = { parentPid: 999, command: 'cat' };
const childPid = 42, fd = 1, sinceSeq = 3, signal = 'SIGTERM', kind = 'pure-builtin';

// Canned inputs keyed by op; expected arguments are the pre-dispatch hosted
// contract the canonical table derives.
const INPUTS = {
  readFile: [path],
  readFileBytes: [path],
  writeFile: [path, content],
  stat: [path],
  lstat: [path],
  hasLegacySymlinkUnder: [path],
  utimes: [path, atimeMs, mtimeMs],
  chmod: [path, mode],
  access: [path, mode],
  chown: [path, uid, gid, options],
  setUmask: [mask],
  readdir: [path],
  exists: [path],
  mkdir: [path],
  rmdir: [path],
  rename: [from, to],
  unlink: [path],
  readlink: [path],
  symlink: [target, path],
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
  fsTruncate: [path, size],
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
const cases = Object.entries(SUPERVISOR_OPS).map(([op, route]) => {
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
assert.deepEqual(Object.keys(INPUTS).sort(), Object.keys(SUPERVISOR_OPS).sort(),
  'INPUTS and the canonical table name the same ops');

const supervisor = Object.create(SupervisorRPC.prototype);
supervisor.ctx = { props: { doId: 'host-id', pid, writerId, mutationOwner } };
let host, receivedEnvelope;
const stub = {
  dispatchWorkspace(envelope) {
    assert.equal(this, stub, 'RPC dispatch keeps the stub receiver');
    receivedEnvelope = envelope;
    return sessionSupervisorOp(host, envelope);
  },
};
supervisor.env = {
  HOSTS: {
    idFromString(value) { assert.equal(value, 'host-id'); return value; },
    get(value) { assert.equal(value, 'host-id'); return stub; },
  },
};
for (const [op, input, envelopeArgs, sentArgs, delegate, expected] of cases) {
  let disposed = 0;
  const answer = op === 'routeLoopback' ? new Response('streamed body') : { value: 'answer' };
  answer[Symbol.dispose] = () => disposed++;
  host = {
    [delegate](...args) {
      assert.equal(this, host);
      assert.deepEqual(args, expected, op);
      return Promise.resolve(answer);
    },
  };
  assert.equal(await supervisor[op](...input), answer, op);
  assert.equal(receivedEnvelope.op, op);
  // The envelope's args must carry the RPC's inputs — the route's numeric
  // slots are indexes into this array, so a dropped arg is a dropped arg.
  assert.deepEqual(receivedEnvelope.args, sentArgs, `${op}: envelope args`);
  assert.equal(disposed, op === 'routeLoopback' ? 0 : 1, `${op}: response lifetime`);
  if (op === 'writeBatchStream') assert.equal(receivedEnvelope.stream, stream);
  if (op === 'routeLoopback') assert.equal(await answer.text(), 'streamed body');
}
assert.equal(cases.length, Object.keys(SUPERVISOR_OPS).length);
for (const op of ['constructor', 'toString', '_rpcInnerDoFetch', 'missing']) {
  await assert.rejects(sessionSupervisorOp({}, { op }), /not served/);
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
