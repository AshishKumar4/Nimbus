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
  'packages/core/src/node-compat/index.ts': ['createNodeCompat', 'nodeFacesOf'],
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
    assert.deepEqual([missing.code, missing.syscall, missing.path], ['ENOENT', 'open', `${cwd}/nope.txt`]);
    await fsPromises.mkdir('d/e', { recursive: true });
    assert.deepEqual(await fsPromises.readdir('d'), ['e']);
    assert.equal((await failure(() => fsPromises.unlink('d'))).code, 'EISDIR');
    await fsPromises.appendFile('a.txt', ', again');
    assert.equal(await fsPromises.readFile('a.txt', 'utf8'), 'hello, again');
  });

  await check('a *Sync call cannot wait', async () => {
    const read = await failure(async () => fs.readFileSync('a.txt'));
    assert.deepEqual([read.code, read.syscall, read.path], ['EAGAIN', 'open', `${cwd}/a.txt`]);
    assert.match(read.message, /readFileSync cannot wait.*fs\.readFile/, read.message);
    assert.equal((await failure(async () => fs.writeFileSync('w.txt', 'x'))).code, 'EAGAIN');
    assert.equal(await box.files.exists(`${cwd}/w.txt`), false, 'a refused writeFileSync wrote nothing');
    assert.equal((await failure(async () => fs.existsSync('a.txt'))).code, 'EAGAIN', 'existsSync throws: false would say absent, unasked');
    assert.equal((await failure(async () => fs.statSync('a.txt'))).syscall, 'stat');
    const options = await failure(async () => fs.readFileSync({}));
    assert.notEqual(options.code, 'EAGAIN', 'its arguments are checked first, as Node checks them');
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
