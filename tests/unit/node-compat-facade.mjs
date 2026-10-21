#!/usr/bin/env bun
// Node's `fs` over a session client (Kinu ask 67): createNodeCompat over
// nodeFacesOf(sandbox) is the same `fs` lifo's node runs (one source,
// node-compat/fs.ts), over the session's asynchronous file calls.
//   - Every asynchronous form works: callbacks, never in their caller's
//     turn, and fs.promises.
//   - A *Sync call that reaches the session throws EAGAIN before anything
//     is asked (the client's isolate cannot wait): its syscall and path,
//     and a message naming the form that can. existsSync throws too: false
//     would say a file is absent when nothing was asked.
//   - Without the session's descriptors there are no streams: ENOSYS.
//   - lifo's node and the facade answer one program value for value
//     (node-compat-differential.mjs); the probe sdk/new/node-compat-differential
//     compares the hosted node's.

import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/sdk/src/sandbox.ts': ['Nimbus'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
  'packages/core/src/node-compat/index.ts': ['createNodeCompat', 'nodeFacesOf', 'createNodeFs'],
});

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'embedder-do');
const ctx = {
  ...facetCtx,
  storage: { ...facetCtx.storage, sql: harness.sql, transactionSync: harness.ctx.storage.transactionSync },
  exports: { SupervisorRPC: ({ props }) => ({ props }) },
  getWebSockets: () => [],
};
const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS: stagedAssets };

const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({
  workspace, ctx, env, ports: new bundle.PortRegistry(),
  lifecycle: { waitUntil: (task) => { facetCtx.waitUntil(task); }, async schedule() {}, async cancel() {} },
});

const box = bundle.Nimbus.fromSession(() => runtime.session({})).sandbox('workspace');

/** `work`'s rejection, which must come. */
async function failure(work) {
  try {
    await work();
  } catch (error) {
    return error;
  }
  assert.fail('expected a failure');
}

const failures = [];
const check = async (name, body) => {
  try {
    await body();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
};

try {
  const cwd = '/tmp/facade';
  await box.files.mkdir(cwd);
  const { fs, fsPromises } = bundle.createNodeCompat(bundle.nodeFacesOf(box), { cwd });

  await check('the asynchronous forms', async () => {
    await fsPromises.writeFile('a.txt', 'hello');
    assert.equal(await box.files.read(`${cwd}/a.txt`), 'hello', 'relative to its cwd, the session\'s file');
    assert.equal(await fsPromises.readFile('a.txt', 'utf8'), 'hello');
    let called = false;
    const read = new Promise((resolve, reject) => fs.readFile('a.txt', 'utf8', (error, text) => {
      called = true;
      if (error) reject(error); else resolve(text);
    }));
    assert.equal(called, false, 'never in its caller\'s turn');
    assert.equal(await read, 'hello');
    const missing = await failure(() => fsPromises.readFile('nope.txt'));
    assert.deepEqual([missing.code, missing.syscall, missing.path], ['ENOENT', 'open', 'nope.txt'], 'named as given, as Node names it');
    await fsPromises.mkdir('d/e', { recursive: true });
    assert.deepEqual(await fsPromises.readdir('d'), ['e']);
    assert.equal((await failure(() => fsPromises.unlink('d'))).code, 'EISDIR');
    await fsPromises.appendFile('a.txt', ', again');
    assert.equal(await fsPromises.readFile('a.txt', 'utf8'), 'hello, again');
  });

  await check('a *Sync call cannot wait', async () => {
    const read = await failure(async () => fs.readFileSync('a.txt'));
    assert.deepEqual([read.code, read.syscall, read.path], ['EAGAIN', 'open', 'a.txt']);
    assert.match(read.message, /readFileSync cannot wait.*fs\.readFile/, read.message);
    assert.equal((await failure(async () => fs.writeFileSync('w.txt', 'x'))).code, 'EAGAIN');
    assert.equal(await box.files.exists(`${cwd}/w.txt`), false, 'a refused writeFileSync wrote nothing');
    assert.equal((await failure(async () => fs.existsSync('a.txt'))).code, 'EAGAIN', 'existsSync throws: false would say absent, unasked');
    assert.equal((await failure(async () => fs.statSync('a.txt'))).syscall, 'stat');
    for (const path of [{}, null]) {
      assert.equal((await failure(async () => fs.readFileSync(path))).code, 'ERR_INVALID_ARG_TYPE', 'its arguments are checked first, as Node checks them');
    }
    assert.equal((await failure(() => fsPromises.readFile({}))).code, 'ERR_INVALID_ARG_TYPE');
  });

  await check('a forced rm of nothing there', async () => {
    await fsPromises.rm('nothing-here', { force: true });
  });

  await check('a path\'s truncate', async () => {
    const truncated = await failure(() => fsPromises.truncate('nothing-here', 0));
    assert.deepEqual([truncated.code, truncated.syscall, truncated.path], ['ENOENT', 'open', 'nothing-here'], 'a path\'s truncate fails as its opening would');
    assert.equal((await failure(() => fsPromises.truncate('nothing-here', 1.5))).code, 'ENOENT', 'opened before its length is checked');
    assert.deepEqual(await (async () => { const e = await failure(() => fsPromises.truncate('d', 0)); return [e.code, e.syscall]; })(), ['EISDIR', 'open']);
  });

  await check('a symlink onto a name taken', async () => {
    const linked = await failure(() => fsPromises.symlink('target', 'a.txt'));
    assert.deepEqual([linked.code, linked.path, linked.dest], ['EEXIST', 'target', 'a.txt'], 'the target, then the link, as given');
  });

  await check('a face\'s errors are its own', async () => {
    const stat = { dev: 1, ino: 2, nlink: 1, type: 'file', size: 1, ctime: 1, atime: 1, mtime: 1, mode: 0o644, uid: 0, gid: 0, revision: 1 };
    const shared = Object.freeze(Object.assign(new Error("ENOENT: no such file or directory, stat '/c/x'"), { code: 'ENOENT', errno: -2, syscall: 'stat', path: '/c/x' }));
    const vanished = () => Object.assign(new Error('gone'), { code: 'ENOENT' });
    const files = {
      stat: async () => { throw shared; },
      lstat: async () => stat,
      readFile: async () => new Uint8Array(0),
      writeFile: async () => {},
      readdir: async () => [],
      unlink: async () => { throw vanished(); },
    };
    const own = bundle.createNodeCompat({ files }, { cwd: '/c' }).fsPromises;
    const relative = await failure(() => own.stat('x'));
    assert.deepEqual([relative.code, relative.errno, relative.path], ['ENOENT', -2, 'x'], 'named as given, though the face\'s error is frozen');
    assert.equal((await failure(() => own.stat('/c/x'))).path, '/c/x', 'and the face\'s error is left as it was for the next call');
    assert.equal(shared.path, '/c/x');
    await own.rm('x', { force: true });
    // Fields a face keeps out of sight (not enumerable) are an errno's all the same.
    const hidden = new Error("ENOENT: no such file or directory, stat '/c/y'");
    for (const [field, value] of Object.entries({ code: 'ENOENT', errno: -2, syscall: 'stat', path: '/c/y' })) {
      Object.defineProperty(hidden, field, { value, enumerable: false });
    }
    const quiet = bundle.createNodeCompat({ files: { ...files, stat: async () => { throw hidden; } } }, { cwd: '/c' }).fsPromises;
    const unseen = await failure(() => quiet.stat('y'));
    assert.deepEqual([unseen.code, unseen.errno, unseen.syscall, unseen.path], ['ENOENT', -2, 'stat', 'y']);
    // A path its class reads, with no setter: the error cannot be renamed where it stands.
    class Gotten extends Error {
      get path() { return '/c/z'; }
    }
    const gotten = bundle.createNodeCompat({ files: { ...files, stat: async () => { throw Object.assign(new Gotten("ENOENT: no such file or directory, stat '/c/z'"), { code: 'ENOENT', errno: -2, syscall: 'stat' }); } } }, { cwd: '/c' }).fsPromises;
    const read = await failure(() => gotten.stat('z'));
    assert.deepEqual([read.code, read.path, read.message], ['ENOENT', 'z', "ENOENT: no such file or directory, stat 'z'"]);
  });

  await check('a frozen error with a stack of its own', async () => {
    const stat = { dev: 1, ino: 2, nlink: 1, type: 'file', size: 1, ctime: 1, atime: 1, mtime: 1, mode: 0o644, uid: 0, gid: 0, revision: 1 };
    const files = { lstat: async () => stat, readFile: async () => new Uint8Array(0), writeFile: async () => {}, readdir: async () => [] };
    // Its stack enumerable: copied, its stack kept.
    const stacked = new Error("ENOENT: no such file or directory, stat '/c/w'");
    Object.defineProperty(stacked, 'stack', { value: 'Error: a stack of its own', enumerable: true });
    Object.freeze(Object.assign(stacked, { code: 'ENOENT', errno: -2, syscall: 'stat', path: '/c/w' }));
    const kept = bundle.createNodeCompat({ files: { ...files, stat: async () => { throw stacked; } } }, { cwd: '/c' }).fsPromises;
    const copied = await failure(() => kept.stat('w'));
    assert.deepEqual([copied.code, copied.path, copied.stack, copied.cause === stacked], ['ENOENT', 'w', 'Error: a stack of its own', true]);
  });

  await check('a synchronous face\'s path truncate', async () => {
    const missing = (syscall, path) => Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${path}'`), { code: 'ENOENT', errno: -2, syscall, path });
    const face = {
      readFile() { throw missing('open', '/s/x'); }, readFileString() { throw missing('open', '/s/x'); }, writeFile() {},
      exists: () => false, isFile: () => false, isDirectory: () => false, readdir: () => [],
      stat(path) { throw missing('stat', path); }, lstat(path) { throw missing('lstat', path); }, truncate(path) { throw missing('truncate', path); },
    };
    const own = bundle.createNodeFs({ sync: face }, { cwd: '/s' });
    const sync = await failure(async () => own.truncateSync('x', 0));
    assert.deepEqual([sync.code, sync.syscall, sync.path], ['ENOENT', 'open', 'x'], 'as its opening would fail, answered now');
  });

  await check('no descriptors, no streams', async () => {
    assert.equal((await failure(async () => fs.createReadStream('a.txt'))).code, 'ENOSYS');
    assert.equal((await failure(async () => fs.createWriteStream('b.txt'))).code, 'ENOSYS');
    assert.equal((await failure(() => fsPromises.open('a.txt'))).code, 'ENOSYS');
    assert.equal((await failure(async () => fs.watch('a.txt'))).code, 'ENOSYS');
  });

} finally {
  await runtime.close();
}

assert.deepEqual(failures, []);
console.log('node-compat-facade: Node\'s fs over a session client, one source with lifo\'s');
