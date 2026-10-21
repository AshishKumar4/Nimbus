#!/usr/bin/env bun
// A session's files answer as Node's fs needs them (Kinu ask 67.2), over
// Workers RPC and over the remote HTTP API alike:
//   - stat is stat(2)'s whole answer: dev, ino, nlink, uid, gid, mode, size
//     and the three times;
//   - mkdir takes mkdir(2)'s options (none is still `mkdir -p`);
//   - unlink and rmdir are their own calls, so a directory is EISDIR to
//     unlink and a file ENOTDIR to rmdir;
//   - appendFile, symlink, realpath, truncate, utimes and chown are calls;
//   - a failed call keeps Node's error fields across HTTP (code, errno,
//     syscall, path), where before it was E_NIMBUS_REMOTE_RPC/500 with a
//     message only.
// Driven through the SDK into a hosted workspace's session, as an embedder's
// client reaches it.

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
  'packages/worker/src/router/index.ts': ['createNimbusHandler'],
  'packages/worker/src/auth/token.ts': ['issueNimbusToken'],
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

const overRpc = bundle.Nimbus.fromSession(() => runtime.session({})).sandbox('workspace');
const rpcEnv = { JWT_SECRET: 'session-files-secret', NIMBUS_SESSION: { idFromName: (name) => name, get: () => runtime.session({}) } };
const handler = bundle.createNimbusHandler({ sdk: { remote: true } });
const token = await bundle.issueNimbusToken(rpcEnv, { tn: 'hosted', scopes: ['sandbox:use'] });
const overHttp = bundle.Nimbus.connect({
  endpoint: 'https://files.test', token,
  fetch: (url, init) => handler.fetch(new Request(url, init), rpcEnv, { waitUntil() {} }),
}).sandbox('workspace');

/** `promise`'s rejection, which must come. */
async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a rejection');
}
const fields = (error) => ({ code: error.code, errno: error.errno, syscall: error.syscall, path: error.path });

const failures = [];
try {
  for (const [via, box] of [['rpc', overRpc], ['http', overHttp]]) {
    const dir = `/tmp/node-ops-${via}`;
    const check = async (name, body) => {
      try {
        await body();
      } catch (error) {
        failures.push(`${via}: ${name}: ${error.message}`);
      }
    };
    await box.files.mkdir(dir);

    await check('stat is stat(2)\'s', async () => {
      await box.files.write(`${dir}/a.txt`, 'abc');
      const stat = await box.files.stat(`${dir}/a.txt`);
      for (const field of ['dev', 'ino', 'nlink', 'uid', 'gid', 'mode', 'size', 'atime', 'mtime', 'ctime']) {
        assert.equal(typeof stat?.[field], 'number', `${field}: ${JSON.stringify(stat)}`);
      }
      assert.deepEqual([stat.type, stat.size, stat.nlink, stat.uid], ['file', 3, 1, 1000]);
    });

    await check('mkdir(2)\'s options', async () => {
      assert.deepEqual(fields(await failure(box.files.mkdir(`${dir}/x/y`, { recursive: false }))),
        { code: 'ENOENT', errno: -2, syscall: 'mkdir', path: `${dir}/x/y` });
      await box.files.mkdir(`${dir}/private`, { mode: 0o700 });
      assert.equal((await box.files.stat(`${dir}/private`)).mode & 0o777, 0o700);
      assert.equal(fields(await failure(box.files.mkdir(`${dir}/private`, {}))).code, 'EEXIST');
      await box.files.mkdir(`${dir}/deep/er/still`);
      assert.equal((await box.files.stat(`${dir}/deep/er/still`)).type, 'directory', 'none is mkdir -p');
      // A mode as stat gives it, its type bits and all, is Node's: the permission bits are kept.
      const { mode } = await box.files.stat(`${dir}/private`);
      await box.files.mkdir(`${dir}/copy`, { mode });
      assert.equal((await box.files.stat(`${dir}/copy`)).mode & 0o7777, mode & 0o7777);
      await failure(box.files.mkdir(`${dir}/bad`, { mode: -1 }));
      assert.equal(await box.files.exists(`${dir}/bad`), false, 'a mode Node refuses is refused');
    });

    await check('unlink and rmdir', async () => {
      await box.files.mkdir(`${dir}/d`, {});
      await box.files.write(`${dir}/d/f`, 'x');
      assert.deepEqual(fields(await failure(box.files.unlink(`${dir}/d`))), { code: 'EISDIR', errno: -21, syscall: 'unlink', path: `${dir}/d` });
      assert.equal(fields(await failure(box.files.rmdir(`${dir}/d/f`))).code, 'ENOTDIR');
      assert.equal(fields(await failure(box.files.rmdir(`${dir}/d`))).code, 'ENOTEMPTY');
      await box.files.unlink(`${dir}/d/f`);
      await box.files.rmdir(`${dir}/d`);
      assert.equal(await box.files.exists(`${dir}/d`), false);
      assert.deepEqual(fields(await failure(box.files.unlink(`${dir}/none`))), { code: 'ENOENT', errno: -2, syscall: 'unlink', path: `${dir}/none` });
    });

    await check('appendFile', async () => {
      await box.files.appendFile(`${dir}/log`, 'one\n');
      await box.files.appendFile(`${dir}/log`, new Uint8Array([0x74, 0x77, 0x6f, 0x0a]));
      assert.equal(await box.files.read(`${dir}/log`), 'one\ntwo\n');
    });

    await check('symlink and realpath', async () => {
      await box.files.write(`${dir}/target.txt`, 't');
      await box.files.symlink('target.txt', `${dir}/link`);
      assert.equal(await box.files.readlink(`${dir}/link`), 'target.txt', 'its text as given');
      assert.equal(await box.files.realpath(`${dir}/link`), `${dir}/target.txt`);
      assert.equal(fields(await failure(box.files.symlink('target.txt', `${dir}/link`))).code, 'EEXIST');
    });

    await check('truncate', async () => {
      await box.files.write(`${dir}/t`, 'abcdef');
      await box.files.truncate(`${dir}/t`, 3);
      assert.equal(await box.files.read(`${dir}/t`), 'abc');
      await box.files.truncate(`${dir}/t`, 5);
      assert.deepEqual([...await box.files.readBytes(`${dir}/t`)], [0x61, 0x62, 0x63, 0, 0], 'extended with zeros');
    });

    await check('utimes', async () => {
      await box.files.write(`${dir}/u`, 'u');
      await box.files.utimes(`${dir}/u`, 1_000_000_000_000, 1_200_000_000_000);
      const stat = await box.files.stat(`${dir}/u`);
      assert.deepEqual([stat.atime, stat.mtime], [1_000_000_000_000, 1_200_000_000_000]);
    });

    await check('chown', async () => {
      await box.files.write(`${dir}/c`, 'c');
      await box.files.chown(`${dir}/c`, null, null);
      assert.deepEqual(fields(await failure(box.files.chown(`${dir}/c`, 0, null))), { code: 'EPERM', errno: -1, syscall: 'chown', path: `${dir}/c` },
        'the session user gives no file away');
    });
  }

  // Across HTTP an errno is the call's answer, not the server failing.
  try {
    const error = await failure(overHttp.files.stat('/tmp/none-at-all/x').then(() => overHttp.files.rmdir('/tmp/none-at-all')));
    if (error.status !== 404) failures.push(`http: ENOENT is 404, not ${error.status}`);
  } catch (error) {
    failures.push(`http: ENOENT's status: ${error.message}`);
  }
} finally {
  await runtime.close();
}

assert.deepEqual(failures, []);
console.log('session-files-node-ops: a session\'s files answer as Node\'s fs needs them, over RPC and HTTP');
