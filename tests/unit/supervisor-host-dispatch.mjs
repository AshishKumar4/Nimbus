#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { buildSessionSupervisorOps } from '../../packages/worker/src/session/supervisor-op.ts';
import { SUPERVISOR_OPS, SUPERVISOR_OP_ROUTES, SUPERVISOR_NATIVE_OPS } from '../../packages/core/src/workspace/supervisor-op.ts';
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
// The descriptor ops all act on one open file, plus a directory for
// readdirHandle; remove/copy/mutation each get their own subject.
const handlePath = '/home/user/handle', handleDir = '/home/user/hdir';
const removePath = '/home/user/rm', copyPath = '/home/user/copy', mutationPath = '/home/user/mut';
const handleContent = 'handle-bytes';
const sessionFs = rawVfs.as(CRED_SESSION_USER);
sessionFs.writeFile('home/user/ren', 'x');
sessionFs.writeFile('home/user/del', 'x');
sessionFs.writeFile('home/user/chmod', 'x');
sessionFs.writeFile('home/user/utimes', 'x');
sessionFs.writeFile('home/user/trunc', 'truncate me');
sessionFs.writeFile('home/user/file', 'seeded\n');
sessionFs.writeFile('home/user/handle', handleContent);
sessionFs.mkdir('home/user/hdir', { recursive: true });
sessionFs.writeFile('home/user/hdir/child', 'c');
sessionFs.mkdir('home/user/rm/inner', { recursive: true });
sessionFs.writeFile('home/user/rm/inner/leaf', 'x');
const bytes = new Uint8Array([1, 2, 3]), content = 'written';
const atimeMs = 100, mtimeMs = 200, mode = 0o640, size = 3;
const uid = CRED_SESSION_USER.uid, gid = CRED_SESSION_USER.gid;
const mask = 0o077, rOk = 0o4, xOk = 0o1, seekTo = 2;
const options = { followSymlinks: false }, epoch = 'epoch', cursor = 9, after = 'after', limit = 32;
const url = 'https://remote.test/', protocols = ['protocol'], id = 7, waitMs = 25, text = 'text';
const code = 0, reason = 'closed', offset = 0, length = 3;
const requests = [{ path, offset, length }], moduleId = 'module', operationId = 'operation';
const payload = { inodes: [], chunks: [] }, stream = encodeWriteBatchStream({ inodes: [], chunks: [] });
const entries = [], data = new TextEncoder().encode('output'), tail = 'tail', cwd = '/cwd', entryCode = 'export {}', port = 8080;
const request = new Request('https://loopback.test/'), loader = 'js', req = { parentPid: 999, command: 'cat' };
const childPid = 42, fd = 1, sinceSeq = 3, signal = 'SIGTERM', kind = 'pure-builtin';
// A fixture is the argument list its RPC is called with — or, for the ops
// that act on a descriptor, a thunk the loop resolves once the op that mints
// the handle has run. `fsOpen` is that op, and the canonical list orders it
// ahead of every op that needs one.
let fileHandle = null, mutationLease = null;
const openHandle = (subject, openFlags) => ops.dispatch({ op: 'fsOpen', args: [subject, openFlags], pid });
const INPUTS = {
  readFile: [path],
  readFileBytes: [path],
  writeFile: [wPath, content],
  stat: [path, options],
  lstat: [linkPath],
  hasLegacySymlinkUnder: [path],
  utimes: [utimesPath, atimeMs, mtimeMs],
  chmod: [chmodPath, mode],
  access: [path, rOk],
  chown: [path, uid, gid, options],
  setUmask: [mask],
  readdir: ['/home/user'],
  exists: [path],
  mkdir: [dirPath, { recursive: true }],
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
  fsOpen: [handlePath, { read: true, write: true }],
  fsFstat: () => [fileHandle.id],
  fsDup: () => [fileHandle.id],
  fsSeek: () => [fileHandle.id, seekTo, 'set'],
  fsSetStatus: () => [fileHandle.id, { append: true }],
  fsReaddirHandle: async () => [(await openHandle(handleDir, { read: true, directory: true })).id],
  fsFtruncate: () => [fileHandle.id, size],
  fsFchmod: () => [fileHandle.id, mode],
  fsFchown: () => [fileHandle.id, uid, gid],
  fsFutimes: () => [fileHandle.id, atimeMs, mtimeMs],
  fsSync: () => [fileHandle.id],
  fsRealpath: [linkPath],
  fsRemove: [removePath, { recursive: true }],
  fsCopyFile: [path, copyPath],
  fsAcquireExclusiveMutation: [mutationPath],
  fsReleaseExclusiveMutation: () => [mutationLease.owner],
  fsRead: () => [fileHandle.id, offset, length],
  fsWrite: () => [fileHandle.id, offset, bytes],
  // Closes a handle of its own: the shared one stays open for the descriptor
  // ops the canonical order runs after it.
  fsClose: async () => [(await openHandle(handlePath, { read: true })).id],
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
  innerDoFetch: [{ bindingName: 'NimbusDO', id: 'inner-id', method: 'GET', url: 'https://inner.test/', headers: [] }],
  fanoutExecute: ['fn-source', [1, 2], { tag: 'probe' }],
  processHostProbe: [],
  hostProcess: [{ entry: 'boot.js' }, { workerKey: 'wk' }],
  awaitHostedOpen: ['wk'],
  awaitHostedBoot: ['wk'],
  routeHostedHttp: ['wk', { method: 'GET', url: 'https://hosted.test/' }],
  cancelHostProcess: ['wk'],
  hmrRelay: ['client-1', 'hmr-message'],
};

// The props the supervisor binding stamps — the envelope's identity fields
// every arg spec reads from.
const PROPS = { pid, writerId, mutationOwner, stream };

// Cases derive from the canonical op list: a routed op carries the route the
// table names — its delegate and its expected arguments — and a native op
// carries none, because the filesystem answers it.
const cases = SUPERVISOR_OPS.map((op) => [op, Object.hasOwn(SUPERVISOR_OP_ROUTES, op) ? SUPERVISOR_OP_ROUTES[op] : undefined]);

// Every fixture names a real op; every real op has a fixture.
assert.deepEqual(Object.keys(INPUTS).sort(), [...SUPERVISOR_OPS].sort(),
  'INPUTS and the canonical op list name the same ops');

// The two tables partition that list: an op is served natively or routed to
// an _rpc* method, never both and never neither.
assert.deepEqual([...SUPERVISOR_NATIVE_OPS, ...Object.keys(SUPERVISOR_OP_ROUTES)].sort(), [...SUPERVISOR_OPS].sort(),
  'the native table and the route table partition SUPERVISOR_OPS');

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
for (const [, route] of cases) {
  if (route) {
    host[route.method] = (...args) => { delegateCalls.push([route.method, ...args]); return Promise.resolve({ value: 'answer' }); };
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
    idFromName(name) { return name; },
    idFromString(value) { assert.equal(value, 'host-id'); return value; },
    get(value) { assert.equal(value, 'host-id'); return stub; },
  },
};

// ── The route travels with the binding ──────────────────────────────────
//
// The platform serves this entrypoint from whichever isolate it likes, and
// that isolate's composition may be absent or another host's. A binding
// minted with a route resolves the host from the route, not from here:
// this isolate composed HOSTS/dispatchWorkspace, the props say
// WORKSPACES/supervisorOp, and the call lands on WORKSPACES.
{
  const routed = Object.create(SupervisorRPC.prototype);
  const seen = [];
  routed.ctx = { props: {
    doId: 'kinu-id', pid, writerId, mutationOwner,
    route: { supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' },
  } };
  routed.env = {
    HOSTS: { idFromName: () => { throw new Error('the composed namespace must not be consulted'); }, idFromString() { throw new Error('composed'); }, get() { throw new Error('composed'); } },
    WORKSPACES: {
      idFromName(name) { return name; },
      idFromString(value) { assert.equal(value, 'kinu-id'); return value; },
      get() { return { supervisorOp(envelope) { seen.push(envelope.op); return Promise.resolve(null); } }; },
    },
  };
  await routed.exists('/anything');
  assert.deepEqual(seen, ['exists'], 'the envelope reached the host the props named');
  // Without WORKSPACES in env the refusal names the route's binding, so an
  // embedder reads which binding its Worker is missing.
  const unbound = Object.create(SupervisorRPC.prototype);
  unbound.ctx = routed.ctx;
  unbound.env = { HOSTS: routed.env.HOSTS };
  await assert.rejects(() => unbound.exists('/anything'), /env\.WORKSPACES must be the Durable Object namespace/);
}

// The ops a process is not allowed to perform at all: the refusal from the
// real filesystem IS their behaviour, so they assert on the error.
const NATIVE_REFUSED = {
  // A descriptor chown is root-only in the VFS (sqlite-vfs.ts openNode.chown),
  // even to the owner's own uid, which the path-based chown does allow.
  fsFchown: /EPERM/,
};

// The five partial mutations answer with the path's revision on either
// side of the mutation (VfsMutationReceipt), which the facet's stamp rule
// consumes; nothing else on this surface returns an object like it.
function assertReceipt(r, label) {
  assert.deepEqual(Object.keys(r).sort(), ['after', 'before'], label);
  assert.ok(Number.isInteger(r.before) && Number.isInteger(r.after) && r.after > r.before, `${label}: after > before`);
}

// Native ops run the real implementation — what they return IS the
// assertion; everything else is a captured delegate call.
const nativeAssert = {
  readFile: (r) => assert.equal(r, 'seeded\n', 'readFile'),
  readFileBytes: (r) => assert.deepEqual(Array.from(r), Array.from(new TextEncoder().encode('seeded\n')), 'readFileBytes'),
  writeFile: async () => assert.equal(dec.decode(kernelVfs.readFile('home/user/w')), content, 'writeFile persisted'),
  stat: (r) => assert.equal(r.type, 'file', 'stat'),
  lstat: (r) => assert.equal(r.type, 'symlink', 'lstat'),
  hasLegacySymlinkUnder: (r) => assert.equal(r, false, 'hasLegacySymlinkUnder'),
  utimes: async (r) => {
    assertReceipt(r, 'utimes answers a mutation receipt');
    const stat = kernelVfs.stat('home/user/utimes');
    assert.equal(stat.atime, atimeMs, 'utimes applied atime');
    assert.equal(stat.mtime, mtimeMs, 'utimes applied mtime');
  },
  chmod: async (r) => {
    assertReceipt(r, 'chmod answers a mutation receipt');
    assert.equal(kernelVfs.stat('home/user/chmod').mode & 0o777, mode, 'chmod applied');
  },
  access: async (r) => {
    assert.equal(r, undefined, 'access grants read on an owned file');
    await assert.rejects(ops.dispatch({ op: 'access', args: [path, xOk], pid }), /EACCES/, 'access refuses execute');
  },
  chown: async (r) => {
    assertReceipt(r, "chown to the caller's own uid/gid is permitted, and answers a mutation receipt");
    const stat = kernelVfs.stat('home/user/file');
    assert.deepEqual([stat.uid, stat.gid], [uid, gid], 'chown kept the owner');
    await assert.rejects(ops.dispatch({ op: 'chown', args: [path, 0, 0], pid }), /EPERM/, 'chown to root is refused');
  },
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
  fsTruncate: async (r) => {
    assertReceipt(r, 'fsTruncate answers a mutation receipt');
    assert.equal(kernelVfs.readFile('home/user/trunc').length, size, 'fsTruncate sized');
  },
  // The descriptor ops, in the order the canonical list runs them: fsOpen
  // mints the handle every one of them addresses.
  fsOpen: (r) => {
    fileHandle = r;
    assert.equal(r.path, 'home/user/handle', 'fsOpen names the file it opened');
    assert.deepEqual([r.flags.read, r.flags.write, r.closed], [true, true, false], 'fsOpen honoured the flags');
  },
  fsFstat: (r) => {
    assert.equal(r.type, 'file', 'fsFstat');
    assert.equal(r.size, handleContent.length, 'fsFstat sizes the open file');
  },
  fsDup: (r) => {
    assert.notEqual(r.id, fileHandle.id, 'fsDup mints a second descriptor');
    assert.equal(r.path, fileHandle.path, 'fsDup keeps the file');
  },
  fsRead: (r) => assert.equal(dec.decode(r), handleContent.slice(offset, offset + length), 'fsRead returns the bytes at the offset'),
  fsWrite: (r) => {
    assert.equal(r, bytes.length, 'fsWrite returns the count written');
    assert.deepEqual([...kernelVfs.readFile('home/user/handle').subarray(0, 3)], [...bytes], 'fsWrite landed through the descriptor');
  },
  fsClose: async (r) => {
    assert.equal(r, undefined, 'fsClose');
    const stat = await ops.dispatch({ op: 'fsFstat', args: [fileHandle.id], pid });
    assert.equal(stat.type, 'file', 'closing one descriptor leaves the shared one open');
  },
  fsSeek: (r) => assert.equal(r, seekTo, 'fsSeek returns the new position'),
  fsSetStatus: async (r) => {
    assert.equal(r, undefined, 'fsSetStatus');
    const duplicate = await ops.dispatch({ op: 'fsDup', args: [fileHandle.id], pid });
    assert.equal(duplicate.flags.append, true, 'fsSetStatus set append on the open descriptor');
  },
  fsReaddirHandle: (r) => assert.deepEqual(r.map((e) => e.name), ['child'], 'fsReaddirHandle lists the directory handle'),
  fsFtruncate: () => assert.equal(kernelVfs.stat('home/user/handle').size, size, 'fsFtruncate sized the open file'),
  fsFchmod: () => assert.equal(kernelVfs.stat('home/user/handle').mode & 0o777, mode, 'fsFchmod applied'),
  fsFutimes: () => {
    const stat = kernelVfs.stat('home/user/handle');
    assert.deepEqual([stat.atime, stat.mtime], [atimeMs, mtimeMs], 'fsFutimes applied');
  },
  fsSync: async (r) => {
    assert.equal(r, undefined, 'fsSync');
    await assert.rejects(ops.dispatch({ op: 'fsSync', args: [fileHandle.id + 9000], pid }), /EBADF/, 'fsSync rejects an unknown descriptor');
  },
  fsRealpath: (r) => assert.equal(r, path, 'fsRealpath resolves the symlink'),
  fsRemove: () => assert.equal(kernelVfs.exists('home/user/rm'), false, 'fsRemove took the tree'),
  fsCopyFile: () => assert.equal(dec.decode(kernelVfs.readFile('home/user/copy')), 'seeded\n', 'fsCopyFile copied the bytes'),
  fsAcquireExclusiveMutation: async (r) => {
    mutationLease = r;
    assert.equal(r.root, 'home/user/mut', 'fsAcquireExclusiveMutation leases the root');
    assert.equal(typeof r.owner, 'string', 'fsAcquireExclusiveMutation names an owner');
    await assert.rejects(ops.dispatch({ op: 'fsAcquireExclusiveMutation', args: [mutationPath], pid }), /EBUSY/, 'the lease excludes a second holder');
  },
  fsReleaseExclusiveMutation: async (r) => {
    assert.equal(r, undefined, 'fsReleaseExclusiveMutation');
    // The lease is gone iff the same root can be leased again.
    const relet = await ops.dispatch({ op: 'fsAcquireExclusiveMutation', args: [mutationPath], pid });
    assert.notEqual(relet.owner, mutationLease.owner, 'the released root leases again');
    await ops.dispatch({ op: 'fsReleaseExclusiveMutation', args: [relet.owner], pid });
  },
  writeBatchStream: (r) => assert.ok(r && typeof r === 'object', 'writeBatchStream returned its result'),
  stdout: () => assert.deepEqual(delegateCalls.at(-1), ['_rpcStdout', pid, data], 'stdout delegate args'),
  stderr: () => assert.deepEqual(delegateCalls.at(-1), ['_rpcStderr', pid, data], 'stderr delegate args'),
};

// Every native op has an assertion of its own — a fixture that dispatched
// and was never checked would be a case the table only looks covered by.
assert.deepEqual([...Object.keys(nativeAssert), ...Object.keys(NATIVE_REFUSED)].sort(), [...SUPERVISOR_NATIVE_OPS].sort(),
  'every native op is asserted against the real filesystem');

for (const [op, route] of cases) {
  const delegate = route?.method;
  let disposed = 0;
  const answer = op === 'routeLoopback' ? new Response('streamed body') : { value: 'answer' };
  answer[Symbol.dispose] = () => disposed++;
  if (route) {
    host[delegate] = (...args) => { delegateCalls.push([delegate, ...args]); return Promise.resolve(answer); };
  }
  // A descriptor op's fixture reads what an earlier op returned, so it is
  // resolved here rather than when the table was written.
  const fixture = INPUTS[op];
  const input = typeof fixture === 'function' ? await fixture() : fixture;
  // writeBatchStream's stream rides the envelope field, not args.
  const envelopeArgs = op === 'writeBatchStream' ? [] : input;
  // cpSpawn rewrites parentPid before the envelope is built.
  const sentArgs = op === 'cpSpawn' ? [{ ...req, parentPid: pid }] : envelopeArgs;
  const expected = !route ? [] : op === 'cpSpawn'
    ? [{ ...req, parentPid: pid }]
    : route.args.map((slot) => typeof slot === 'number' ? envelopeArgs[slot] : PROPS[slot]);
  let result, failure;
  const droveDirect = typeof supervisor[op] !== 'function';
  try {
    if (!droveDirect) {
      result = await supervisor[op](...input);
      assert.equal(receivedEnvelope.op, op);
      // The envelope's args must carry the RPC's inputs — the route's numeric
      // slots are indexes into this array, so a dropped arg is a dropped arg.
      assert.deepEqual(receivedEnvelope.args, sentArgs, `${op}: envelope args`);
      if (op === 'writeBatchStream') assert.equal(receivedEnvelope.stream, stream);
    } else {
      // No session-side convenience method: peers dispatch these envelopes
      // straight onto the host's composed dispatch method (hostOpDispatch).
      // The routed half is what the table names — drive it directly. The
      // caller owns the response — disposal happens in the RPC layer this
      // path bypasses (callers dispose via disposeRpcResource).
      result = await ops.dispatch({ op, args: envelopeArgs, pid, writerId, mutationOwner });
    }
  } catch (error) {
    if (!Object.hasOwn(NATIVE_REFUSED, op)) throw error;
    failure = error;
  }
  if (!route) {
    if (Object.hasOwn(NATIVE_REFUSED, op)) {
      assert.match(String(failure), NATIVE_REFUSED[op], `${op}: the filesystem refuses this process`);
    } else {
      await nativeAssert[op](result);
    }
  } else {
    // Routed to the session's _rpc* surface — the captured call is the
    // contract the canonical table names, and the response is disposed once
    // the RPC is done with it (routeLoopback's body streams on).
    assert.deepEqual(delegateCalls.at(-1), [delegate, ...expected], `${op}: delegate args`);
    assert.equal(disposed, (op === 'routeLoopback' || droveDirect) ? 0 : 1, `${op}: response lifetime`);
    assert.equal(result, answer, op);
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
await assert.rejects(supervisor.readFile('/a'), /env\.HOSTS must be the Durable Object namespace/);
const nativeCount = SUPERVISOR_NATIVE_OPS.size;
console.log(`supervisor-host-dispatch: ${nativeCount} native ops answer from the real filesystem, `
  + `${cases.length - nativeCount} routes preserve arguments, identity and response lifetimes`);
