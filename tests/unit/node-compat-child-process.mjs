#!/usr/bin/env bun
// Node's `child_process` over a session client (Kinu ask 67):
// createNodeCompat over nodeFacesOf(sandbox) starts each child by its argv
// through the session's start (sandbox.startProgram), over Workers RPC and
// over the remote HTTP API alike:
//   - exec exiting 3 is an error with code 3 and both outputs; a program
//     killed by SIGTERM ends code null, signal 'SIGTERM'; execFile of a
//     missing program is the 'error' event, ENOENT, 'spawn <file>';
//   - spawn('cat') echoes input written after the start, every byte value,
//     and 1 MiB to a slow reader, in order;
//   - maxBuffer, encoding 'buffer', timeout and util.promisify as Node's;
//   - execSync, execFileSync and spawnSync refuse:
//     ERR_NIMBUS_SYNC_CHILD_PROCESS, the hosted node's code.
// The probe sdk/new/node-compat-child-process compares the facade with the
// hosted node's own child_process, value for value.

import assert from 'node:assert/strict';
import { promisify } from 'node:util';

import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';
import { childDifferential } from './lib/node-child-process-differential.mjs';

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

const overRpc = bundle.Nimbus.fromSession(() => runtime.session({})).sandbox('workspace');
const rpcEnv = { JWT_SECRET: 'child-process-secret', NIMBUS_SESSION: { idFromName: (name) => name, get: () => runtime.session({}) } };
const handler = bundle.createNimbusHandler({ sdk: { remote: true } });
const token = await bundle.issueNimbusToken(rpcEnv, { tn: 'hosted', scopes: ['sandbox:use'] });
const overHttp = bundle.Nimbus.connect({
  endpoint: 'https://child-process.test', token,
  fetch: (url, init) => handler.fetch(new Request(url, init), rpcEnv, { waitUntil() {} }),
}).sandbox('workspace');

const failures = [];
try {
  for (const [via, box] of [['rpc', overRpc], ['http', overHttp]]) {
    const check = async (name, body) => {
      let timer;
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('not done within 60 s')), 60_000); });
      const began = Date.now();
      try {
        await Promise.race([body(), late]);
      } catch (error) {
        failures.push(`${via}: ${name}: ${error.message}`);
      } finally {
        clearTimeout(timer);
        console.log(`  ${via}: ${name}: ${Date.now() - began} ms`);
      }
    };
    const cwd = `/tmp/children-${via}`;
    await box.files.mkdir(cwd);
    const cp = bundle.createNodeCompat(bundle.nodeFacesOf(box), { cwd }).childProcess;

    await check('the differential\'s program', async () => {
      const out = await childDifferential(cp, (step) => console.log(`    ${via}: ${step} done`));
      assert.deepEqual(out.exit3, {
        code: 3, killed: false, signal: null, cmd: 'echo out; echo err >&2; exit 3',
        message: 'Command failed: echo out; echo err >&2; exit 3\nerr\n', stdout: 'out\n', stderr: 'err\n',
      });
      assert.deepEqual(out.sigterm, { code: null, signal: 'SIGTERM', killed: true });
      assert.deepEqual(out.missing, { code: 'ENOENT', errno: -2, syscall: 'spawn no-such-program-67', path: 'no-such-program-67', spawnargs: ['a'] });
      assert.deepEqual(out.bytes, { code: 0, length: 256, same: true });
      assert.deepEqual(out.mebibyte, { code: 0, length: 1024 * 1024, same: true });
    });

    await check('its cwd, relative ones from the facade\'s', async () => {
      await box.files.mkdir(`${cwd}/sub`);
      const { stdout } = await promisify(cp.exec)('pwd', { cwd: 'sub' });
      assert.equal(stdout, `${cwd}/sub\n`);
      const { stdout: here } = await promisify(cp.execFile)('pwd');
      assert.equal(here, `${cwd}\n`);
    });

    await check('its environment: given, or the session\'s', async () => {
      const { stdout } = await promisify(cp.exec)('echo "$ONLY_HERE"', { env: { ONLY_HERE: 'given', PATH: '/usr/bin:/bin' } });
      assert.equal(stdout, 'given\n');
      const { stdout: home } = await promisify(cp.exec)('echo "$HOME"');
      assert.equal(home, '/home/user\n', 'none given: the session\'s');
    });

    await check('maxBuffer', async () => {
      const error = await promisify(cp.exec)('printf %2000s x', { maxBuffer: 100 }).then(() => null, (e) => e);
      assert.equal(error?.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      assert.equal(error.stdout.length, 100, 'what fit is kept');
    });

    await check('encoding buffer', async () => {
      const { stdout } = await promisify(cp.execFile)('printf', ['\\377'], { encoding: 'buffer' });
      assert.ok(Buffer.isBuffer(stdout));
      assert.deepEqual([...stdout], [0xff]);
    });

    await check('timeout', async () => {
      const error = await promisify(cp.exec)('sleep 600', { timeout: 100 }).then(() => null, (e) => e);
      assert.deepEqual([error?.killed, error?.signal, error?.code], [true, 'SIGTERM', null]);
    });

    await check('the synchronous forms refuse', async () => {
      for (const run of [() => cp.execSync('true'), () => cp.execFileSync('true'), () => cp.spawnSync('true')]) {
        assert.throws(run, { code: 'ERR_NIMBUS_SYNC_CHILD_PROCESS' });
      }
    });

    await check('a kill before the start', async () => {
      const child = cp.spawn('sleep', ['600']);
      assert.equal(child.kill('SIGTERM'), true, 'sent, once it runs');
      const [code, signal] = await new Promise((resolve) => child.on('exit', (...ended) => resolve(ended)));
      assert.deepEqual([code, signal, child.kill()], [null, 'SIGTERM', false]);
    });
  }
} finally {
  await runtime.close();
}

assert.deepEqual(failures, []);
console.log('node-compat-child-process: Node\'s child_process over a session client, over RPC and HTTP');
