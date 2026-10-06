#!/usr/bin/env bun
// An exec names itself with `execId`, every process it starts carries the
// name in the process table, so does everything those processes spawn, and a
// port's listener record reports it. Kinu links a listening port to the job
// that started it, so a dev server reads as "serving".
//
// Driven through composeHostedRuntime with the real shell, the node runtime
// handler, the FacetManager and the SessionProcessSupervisor. The program in
// the facet is a stub, so its listen() is registered the way the http shim's
// is, through the manager, and its child_process.spawn the way the shim's is,
// through the cpSpawn supervisor op with its own pid:
//   [1] Kinu's acceptance: exec { execId: 'j1' } runs `node server.js`; its
//       listener on 8080 reports 'j1'; a child it spawns reports 'j1'; an
//       exec with no execId tags nothing and reports the records it did;
//   [2] a startProcess background job, a call on a named shell, a child
//       shell and a package script tag what they start; the next call on
//       the named shell, unnamed, does not;
//   [3] an id outside the rule is refused before anything runs, on every
//       entry point;
//   [4] the SDK sends it and reads it back on processes, ports and apps,
//       over fromSession, fromEnv and connect (through the remote API);
//   [5] a `bun run` script runs as the process that ran it, as an `npm run`
//       script does, so the server it starts carries the exec id (it ran as
//       the workspace shell).

import assert from 'node:assert/strict';

import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/worker/src/router/remote-api.ts': ['handleNimbusRemoteApi'],
  'packages/worker/src/auth/token.ts': ['issueNimbusToken'],
  'packages/sdk/src/sandbox.ts': ['Nimbus'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
});

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const ASSETS = stagedAssets;

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
const env = { WORKSPACES: { idFromName() {}, idFromString() {}, get() {} }, LOADER: world.loader, ASSETS };

const vfs = new bundle.SqliteVFS(harness.sql, harness.ctx);
const processes = new bundle.SessionProcessSupervisor();
processes.setPidBase(bundle.PID_GEN_STRIDE);
const ports = new bundle.PortRegistry();
const workspace = await bundle.NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx, vfs, processes, generation: 1 });
const runtime = await bundle.composeHostedRuntime({
  workspace,
  ctx,
  env,
  ports,
  lifecycle: { waitUntil: (task) => facetCtx.waitUntil(task), async schedule() {}, async cancel() {} },
});

const kernel = runtime.files.as(bundle.CRED_KERNEL);
const SERVER = "require('http').createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT || 8080));\n";
await kernel.mkdir('/home/user/app', { recursive: true, mode: 0o755 });
await kernel.writeFile('/home/user/app/server.js', SERVER, { mode: 0o644 });
for (const name of ['other.js', 'job.js', 'named.js', 'nested.js', 'after.js', 'dev.js', 'bunserve.js', 'sdk.js', 'env.js', 'remote.js']) {
  await kernel.writeFile(`/home/user/app/${name}`, SERVER, { mode: 0o644 });
}
await kernel.writeFile('/home/user/app/package.json', JSON.stringify({ name: 'app', scripts: { dev: 'node dev.js', serve: 'node bunserve.js' } }), { mode: 0o644 });

const fm = () => runtime.facets().manager;
/** The resident a call started for `script`, still running. */
const residentOf = (script) => {
  const found = processes.getAll().filter((p) => p.state === 'running' && p.longRunning && p.argv.some((arg) => arg.endsWith(script)));
  assert.equal(found.length, 1, `one resident runs ${script}: ${JSON.stringify(processes.getAll().map(({ pid, command, argv, state }) => ({ pid, command, argv, state })))}`);
  return found[0];
};
/** What the http shim's listen() does: the manager registers the pid's port. */
const listen = (pid, port) => fm().registerPort(pid, port);
/** What the child_process shim's spawn() does: cpSpawn, with the caller's own pid. */
const spawnChild = (pid, command, args) => runtime.supervisorOp({
  op: 'cpSpawn',
  args: [{ command, args, cwd: '/home/user/app', env: {}, parentPid: pid, stdio: ['pipe', 'pipe', 'pipe'] }],
  pid,
});
const portRecord = async (port) => (await runtime.listPorts()).find((record) => record.port === port);
const processRecord = async (pid) => (await runtime.listProcesses()).find((record) => record.pid === pid);

try {
  // ── [1] Kinu's acceptance ──────────────────────────────────────────────
  const started = await runtime.exec('node server.js', { execId: 'j1', cwd: '/home/user/app' });
  assert.equal(started.exitCode, 0, JSON.stringify(started));
  const server = residentOf('server.js');
  await listen(server.pid, 8080);
  assert.equal((await portRecord(8080))?.execId, 'j1', `the listener on 8080 reports j1: ${JSON.stringify(await runtime.listPorts())}`);
  assert.equal((await processRecord(server.pid))?.execId, 'j1', 'and so does the server process');
  const summary = (await fm().listResidentApps()).find((app) => app.pid === server.pid);
  assert.equal(summary?.execId, 'j1', `and the manager's own app summary: ${JSON.stringify(summary)}`);

  const { childPid } = await spawnChild(server.pid, 'node', ['-e', '1']);
  assert.equal(processes.get(childPid)?.parentPid, server.pid, 'the child is the server\'s');
  assert.equal((await processRecord(childPid))?.execId, 'j1', 'a child the server spawns reports j1');

  const plain = await runtime.exec('node other.js', { cwd: '/home/user/app' });
  assert.equal(plain.exitCode, 0, JSON.stringify(plain));
  const other = residentOf('other.js');
  await listen(other.pid, 8081);
  const otherPort = await portRecord(8081);
  assert.deepEqual(Object.keys(otherPort).sort(), ['capability', 'pid', 'port', 'registeredAt'], `an untagged listener's record is unchanged: ${JSON.stringify(otherPort)}`);
  const otherProcess = await processRecord(other.pid);
  assert.equal('execId' in otherProcess, false, `an untagged process reports no execId: ${JSON.stringify(otherProcess)}`);
  assert.equal(processes.get(other.pid).execId, undefined);
  const otherSummary = (await fm().listResidentApps()).find((app) => app.pid === other.pid);
  assert.equal('execId' in otherSummary, false, `an untagged app summary is unchanged: ${JSON.stringify(otherSummary)}`);
  console.log('  [1] exec j1 → node server.js on 8080 reports j1, its child reports j1, no execId is unchanged');

  // ── [2] a background job, a named shell, a child shell ─────────────────
  const job = await runtime.startProcess('node job.js', { execId: 'j2', cwd: '/home/user/app' });
  assert.equal(job.process.execId, 'j2', `startProcess reports its job's execId: ${JSON.stringify(job.process)}`);
  const jobServer = residentOf('job.js');
  assert.equal(jobServer.pid, job.pid, 'the background job\'s node adopted the job pid');
  await listen(job.pid, 8082);
  assert.equal((await portRecord(8082))?.execId, 'j2', 'its listener reports j2');

  const named = await runtime.exec('cd /home/user/app && node named.js', { execId: 'j3', shellId: 'agent' });
  assert.equal(named.exitCode, 0, JSON.stringify(named));
  const namedServer = residentOf('named.js');
  await listen(namedServer.pid, 8083);
  assert.equal((await portRecord(8083))?.execId, 'j3', 'a call on a named shell tags what it starts');
  const nested = await runtime.exec(`sh -c 'node nested.js'`, { execId: 'j4', shellId: 'agent' });
  assert.equal(nested.exitCode, 0, JSON.stringify(nested));
  const nestedShell = processes.getAll().filter((p) => p.command === 'sh' && p.execId === 'j4');
  assert.equal(nestedShell.length, 1, 'the child shell carries the call\'s execId');
  assert.equal(residentOf('nested.js').execId, 'j4', 'and so does the server it starts');
  const script = await runtime.exec('npm run dev', { execId: 'j5', cwd: '/home/user/app' });
  assert.equal(script.exitCode, 0, JSON.stringify(script));
  assert.equal(residentOf('dev.js').execId, 'j5', 'a server a package script starts carries it');
  const after = await runtime.exec('node after.js', { shellId: 'agent' });
  assert.equal(after.exitCode, 0, JSON.stringify(after));
  assert.equal(residentOf('after.js').execId, undefined, 'the execId is the call\'s, not the shell\'s: the next call on it tags nothing');
  console.log('  [2] startProcess, a named shell, a child shell and npm run tag what they start; the next call does not inherit it');

  // ── [3] the rule, refused before anything runs ─────────────────────────
  const before = processes.getAll().length;
  const invalid = ['', 'has space', '-leading', 'x'.repeat(161), 'semi;colon', 'slash/y', 'ünï', 7];
  for (const execId of invalid) {
    await assert.rejects(runtime.exec('echo ran', { execId }), /execId must be 1 to 160 characters/, `exec refuses ${JSON.stringify(execId)}`);
  }
  await assert.rejects(runtime.execStream('echo ran', { execId: 'bad id' }), /execId must be/, 'execStream refuses it');
  await assert.rejects(runtime.startProcess('echo ran', { execId: 'bad id' }), /execId must be/, 'startProcess refuses it');
  await assert.rejects(runtime.runCode('1', { execId: 'bad id' }), /execId must be/, 'runCode refuses it');
  assert.equal(processes.getAll().length, before, 'nothing ran');
  for (const execId of ['a', 'J'.repeat(160), 'job_1.2:3-x', '0f8a6c2e-9b1d-4c33-8e57-6d1a2b3c4d5e']) {
    const ok = await runtime.exec('true', { execId });
    assert.equal(ok.exitCode, 0, `${execId} is a valid execId`);
  }
  console.log('  [3] an execId outside 1-160 of [A-Za-z0-9._:-] (leading alnum) is refused before anything runs');

  // ── [4] the SDK, over each way of reaching a session ───────────────────
  const remoteEnv = {
    JWT_SECRET: 'unit-exec-id-secret',
    NIMBUS_SESSION: { idFromName: (name) => name, get: () => runtime.session({}) },
  };
  const token = await bundle.issueNimbusToken(remoteEnv, { tn: 'unit', sub: 'owner', scopes: ['sandbox:use'], sid: 'box' });
  const remoteFetch = (url, init) => bundle.handleNimbusRemoteApi(new Request(url, init), remoteEnv, { remote: true });
  const clients = [
    ['fromSession', bundle.Nimbus.fromSession(() => runtime.session({})).sandbox('box'), 'sdk.js', 8084],
    ['fromEnv', bundle.Nimbus.fromEnv(remoteEnv).sandbox('box'), 'env.js', 8085],
    ['connect', bundle.Nimbus.connect({ endpoint: 'https://unit.test', token, fetch: remoteFetch }).sandbox('box'), 'remote.js', 8086],
  ];
  for (const [via, box, script, port] of clients) {
    const execId = `sdk:${via}`;
    const ran = await box.exec(`node ${script}`, { execId, cwd: '/home/user/app' });
    assert.equal(ran.exitCode, 0, `${via}: ${JSON.stringify(ran)}`);
    const pid = residentOf(script).pid;
    await listen(pid, port);
    const listed = (await box.ports.list()).find((record) => record.port === port);
    assert.deepEqual({ pid: listed?.pid, execId: listed?.execId }, { pid, execId }, `${via}: ports.list() reports it`);
    assert.equal((await box.processes.list()).find((record) => record.pid === pid)?.execId, execId, `${via}: processes.list() reports it`);
    const app = (await box.apps.list()).find((record) => record.pid === pid);
    assert.equal(app?.execId, execId, `${via}: apps.list() reports it: ${JSON.stringify(app)}`);
    const exposed = await box.apps.expose({ port });
    assert.equal(exposed.execId, execId, `${via}: apps.expose() reports it`);
    assert.equal((await box.ports.expose(port)).execId, execId, `${via}: ports.expose() reports it`);
    const background = await box.startProcess('sleep 30', { execId: `${execId}:bg` });
    assert.equal(background.process.execId, `${execId}:bg`, `${via}: startProcess's process reports it`);
    await box.processes.kill(background.pid);
    await assert.rejects(box.exec('echo ran', { execId: 'not valid' }), /execId must be 1 to 160 characters/, `${via}: an invalid execId is refused`);
    const untagged = (await box.ports.list()).find((record) => record.port === 8081);
    assert.equal('execId' in untagged, false, `${via}: an untagged listener carries no execId`);
  }
  const refused = await remoteFetch('https://unit.test/api/nimbus/v1/sandboxes/box/rpc', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'exec', args: ['echo ran', { execId: 'not valid' }] }),
  });
  assert.equal(refused.status, 400, 'the remote API refuses it as a bad argument');
  assert.equal((await refused.json()).code, 'E_ARG_SHAPE');
  console.log('  [4] the SDK sends execId and reads it back on processes, ports and apps over fromSession, fromEnv and connect');

  // ── [5] bun run: the script runs as the process that ran it ────────────
  const bunRun = await runtime.exec('bun run serve', { execId: 'j6', cwd: '/home/user/app' });
  assert.equal(bunRun.exitCode, 0, JSON.stringify(bunRun));
  assert.equal(residentOf('bunserve.js').execId, 'j6', 'a server a `bun run` script starts carries the exec id');
  console.log('  [5] a server a `bun run` script starts carries the exec id');
} finally {
  await runtime.close();
}

console.log('exec-id OK');
