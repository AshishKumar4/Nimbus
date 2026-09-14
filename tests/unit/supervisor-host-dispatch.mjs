#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { composeFabric } from '../../packages/platform/src/composition.ts';
import { sessionSupervisorOp } from '../../packages/worker/src/session/supervisor-op.ts';

const build = await Bun.build({
  entrypoints: [new URL('../../packages/worker/src/session/supervisor-rpc.ts', import.meta.url).pathname],
  target: 'bun',
  plugins: [{
    name: 'supervisor-entrypoint-host',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export class WorkerEntrypoint {}', loader: 'js',
      }));
      builder.onResolve({ filter: /^@nimbus-sh\/platform\/composition\.js$/ }, () => ({
        path: new URL('../../packages/platform/src/composition.ts', import.meta.url).pathname,
        external: true,
      }));
    },
  }],
});
assert.equal(build.success, true, build.logs.map(String).join('\n'));
const { SupervisorRPC } = await import('data:text/javascript;base64,' + Buffer.from(await build.outputs[0].text()).toString('base64'));
composeFabric({ supervisorEntrypoint: 'Supervisor', hostNamespace: 'HOSTS', hostDispatchMethod: 'dispatchWorkspace' });
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

// Expected arguments are the pre-dispatch hosted contract, including identity order.
const cases = [
  ['readFile', [path], '_rpcReadFile', [path, pid]],
  ['readFileBytes', [path], '_rpcReadFileBytes', [path, pid]],
  ['writeFile', [path, content], '_rpcWriteFile', [path, content, pid]],
  ['stat', [path], '_rpcStat', [path, pid]],
  ['lstat', [path], '_rpcLstat', [path, pid]],
  ['hasLegacySymlinkUnder', [path], '_rpcHasLegacySymlinkUnder', [path, pid]],
  ['utimes', [path, atimeMs, mtimeMs], '_rpcUtimes', [path, atimeMs, mtimeMs, pid]],
  ['chmod', [path, mode], '_rpcChmod', [path, mode, pid]],
  ['access', [path, mode], '_rpcAccess', [path, mode, pid]],
  ['chown', [path, uid, gid, options], '_rpcChown', [path, uid, gid, pid, options]],
  ['setUmask', [mask], '_rpcSetUmask', [mask, pid]],
  ['readdir', [path], '_rpcReaddir', [path, pid]],
  ['exists', [path], '_rpcExists', [path, pid]],
  ['mkdir', [path], '_rpcMkdir', [path, pid]],
  ['rmdir', [path], '_rpcRmdir', [path, pid]],
  ['rename', [from, to], '_rpcRename', [from, to, pid]],
  ['unlink', [path], '_rpcUnlink', [path, pid]],
  ['readlink', [path], '_rpcReadlink', [path, pid]],
  ['symlink', [target, path], '_rpcSymlink', [target, path, pid]],
  ['fsAcquire', [epoch, cursor], '_rpcFsAcquire', [epoch, cursor, pid]],
  ['fsRevision', [path], '_rpcFsRevision', [path, pid]],
  ['fsList', [after, limit], '_rpcFsList', [after ?? null, limit ?? null, pid]],
  ['wsOpen', [url, protocols], '_rpcWsOpen', [url, protocols, pid]],
  ['wsPoll', [id, waitMs], '_rpcWsPoll', [id, waitMs, pid]],
  ['wsSend', [id, text, bytes], '_rpcWsSend', [id, text, bytes, pid]],
  ['wsClose', [id, code, reason], '_rpcWsClose', [id, code, reason, pid]],
  ['fsOpen', [path, flags], '_rpcFsOpen', [path, flags, pid]],
  ['fsRead', [handleId, offset, length], '_rpcFsRead', [handleId, offset, length, pid]],
  ['fsWrite', [handleId, offset, bytes], '_rpcFsWrite', [handleId, offset, bytes, pid]],
  ['fsClose', [handleId], '_rpcFsClose', [handleId, pid]],
  ['fsReadRange', [path, offset, length], '_rpcFsReadRange', [path, offset, length, pid]],
  ['fsReadRangeUncached', [path, offset, length], '_rpcFsReadRangeUncached', [path, offset, length, pid]],
  ['fsReadBatch', [requests], '_rpcFsReadBatch', [requests, pid]],
  ['fsWriteRange', [path, offset, bytes], '_rpcFsWriteRange', [path, offset, bytes, pid]],
  ['fsAppend', [path, moduleId, operationId, bytes], '_rpcFsAppend', [path, writerId, moduleId, operationId, bytes, pid]],
  ['fsAppendAck', [moduleId, operationId], '_rpcFsAppendAck', [writerId, moduleId, operationId, pid]],
  ['fsTruncate', [path, size], '_rpcFsTruncate', [path, size, pid]],
  ['writeBatch', [payload], '_rpcWriteBatch', [payload, pid]],
  ['writeBatchStream', [stream], '_rpcWriteBatchStream', [stream, typeof mutationOwner === 'string' ? mutationOwner : undefined, pid]],
  ['putRegistryEntries', [entries], '_rpcPutRegistryEntries', [entries]],
  ['stdout', [data], '_rpcStdout', [pid, data]],
  ['stderr', [data], '_rpcStderr', [pid, data]],
  ['reportExit', [code, tail], '_rpcReportExit', [pid, code, tail || '']],
  ['prefetch', [cwd, entryCode], '_rpcPrefetch', [cwd, entryCode]],
  ['registerPort', [port], '_rpcRegisterPort', [pid, port]],
  ['unregisterPort', [port], '_rpcUnregisterPort', [port]],
  ['routeLoopback', [port, request], '_rpcRouteLoopback', [port, request]],
  ['transform', [code, loader], '_rpcTransform', [code, loader]],
  ['cpSpawn', [req], '_rpcCpSpawn', [{ ...req, parentPid: pid }]],
  ['cpStdinWrite', [childPid, data], '_rpcCpStdinWrite', [childPid, data]],
  ['cpStdinEnd', [childPid], '_rpcCpStdinEnd', [childPid]],
  ['cpReadStdin', [childPid, waitMs], '_rpcCpReadStdin', [childPid, waitMs]],
  ['cpReadOutput', [childPid, fd, sinceSeq, waitMs], '_rpcCpReadOutput', [childPid, fd, sinceSeq, waitMs]],
  ['cpDrainOutput', [childPid], '_rpcCpDrainOutput', [childPid]],
  ['cpKill', [childPid, signal], '_rpcCpKill', [childPid, signal]],
  ['cpWait', [childPid, waitMs], '_rpcCpWait', [childPid, waitMs]],
  ['cpDispatchInline', [req, kind], '_rpcCpDispatchInline', [req, kind]],
];
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
for (const [op, input, delegate, expected] of cases) {
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
  assert.equal(disposed, op === 'routeLoopback' ? 0 : 1, `${op}: response lifetime`);
  if (op === 'writeBatchStream') assert.equal(receivedEnvelope.stream, stream);
  if (op === 'routeLoopback') assert.equal(await answer.text(), 'streamed body');
}
assert.equal(cases.length, 57);
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
console.log('supervisor-host-dispatch: 57 routes preserve arguments, identity and response lifetimes');
