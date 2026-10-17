#!/usr/bin/env bun
// Host helpers a command starts act as the process that started them, never
// as the kernel: `wrangler dev` reads its config, migrations and stores, and
// bundles its Worker, as the process that ran it; a resident process's boot
// reads the images it names by path as that process. Each is refused what the
// process is refused: here, a root-owned 0600 file reached through a symlink
// the user made. Red before: each read as CRED_KERNEL, so a project symlink
// made the host read, and use, a file its user could not.

import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';
import { hostedLifecycle } from './lib/hosted-lifecycle.mjs';
import { importWorkerBundle } from './lib/worker-bundle.mjs';

const bundle = await importWorkerBundle({
  'packages/worker/src/workspace-host.ts': ['composeHostedRuntime'],
  'packages/core/src/workspace/nimbus-workspace.ts': ['NimbusWorkspace'],
  'packages/core/src/runtime/session-process-supervisor.ts': ['SessionProcessSupervisor'],
  'packages/core/src/runtime/port-registry.ts': ['PortRegistry'],
  'packages/core/src/vfs/sqlite-vfs.ts': ['SqliteVFS'],
  'packages/core/src/runtime/process-table.ts': ['PID_GEN_STRIDE'],
  'packages/core/src/runtime/os-contracts.ts': ['CRED_KERNEL', 'CRED_SESSION_USER'],
  'packages/fabric/src/composition.ts': ['composeFabric'],
  'packages/worker/src/wrangler/nimbus-wrangler.ts': ['NimbusWrangler'],
});
const { CRED_KERNEL, CRED_SESSION_USER } = bundle;

bundle.composeFabric({ supervisorEntrypoint: 'SupervisorRPC', hostNamespace: 'WORKSPACES', hostDispatchMethod: 'supervisorOp' });

const world = createFacetWorld(() => ({
  async startProcess() { return { ok: true }; },
  async handleHttpRequest() { return new Response('ok'); },
}), { resolveConfig: false });
const harness = createSqliteVfsTestHarness();
const facetCtx = createFacetCtx(world, 'command-host-credential');
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
  workspace, ctx, env, ports: new bundle.PortRegistry(), lifecycle: hostedLifecycle(ctx, () => runtime),
});

const kernel = vfs.as(CRED_KERNEL);
const user = vfs.as(CRED_SESSION_USER);
const denied = /EACCES|permission denied/i;
/** A root-owned 0600 file at `path`, which the session's user cannot read. */
const rootOnly = (path, text) => {
  kernel.writeFile(path, text, { mode: 0o600 });
  kernel.chown(path, 0, 0);
};

// ── wrangler dev reads its config as the process that ran it ───────────────
{
  user.mkdir('home/user/w/src', { recursive: true });
  user.writeFile('home/user/w/src/index.js', 'export default { fetch() { return new Response("ok"); } };\n');
  rootOnly('home/user/w/secret.jsonc', JSON.stringify({ name: 'leaked-secret', main: 'src/index.js', compatibility_date: '2026-09-26' }));
  user.symlink('secret.jsonc', 'home/user/w/wrangler.jsonc');
  const result = await runtime.exec('wrangler dev', { cwd: '/home/user/w' });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, denied, `wrangler dev read a config its user cannot: ${output.slice(-1200)}`);
  assert.doesNotMatch(output, /leaked-secret/);
  await runtime.exec('wrangler stop', { cwd: '/home/user/w' });
  console.log('  wrangler dev reads its config as the process that ran it');
}

// ── wrangler dev's stores, kept as root by earlier releases, are its user's ──
{
  user.mkdir('home/user/s/src', { recursive: true });
  user.writeFile('home/user/s/src/index.js', 'export default { fetch() { return new Response("ok"); } };\n');
  user.writeFile('home/user/s/wrangler.jsonc', JSON.stringify({
    name: 's', main: 'src/index.js', compatibility_date: '2026-09-26',
    kv_namespaces: [{ binding: 'KV', id: 'kv' }], r2_buckets: [{ binding: 'R2', bucket_name: 'r2' }],
  }));
  // As a release through worker 0.17.0 left them.
  const dirs = ['home/user/s/.nimbus', 'home/user/s/.nimbus/kv', 'home/user/s/.nimbus/kv/KV', 'home/user/s/.nimbus/r2', 'home/user/s/.nimbus/r2/R2'];
  for (const dir of dirs) kernel.mkdir(dir, { mode: 0o755 });
  const objects = ['home/user/s/.nimbus/kv/KV/key', 'home/user/s/.nimbus/r2/R2/object'];
  for (const object of objects) kernel.writeFile(object, 'stored', { mode: 0o644 });
  // Beside them, as in a HOME the runtime store shares: the kernel's, and it stays the kernel's.
  const runtimeStore = ['home/user/s/.nimbus/runtimes', 'home/user/s/.nimbus/runtimes/tool', 'home/user/s/.nimbus/runtimes/tool/manifest.json'];
  kernel.mkdir(runtimeStore[0], { mode: 0o755 });
  kernel.mkdir(runtimeStore[1], { mode: 0o755 });
  kernel.writeFile(runtimeStore[2], '{}', { mode: 0o644 });
  await runtime.exec('wrangler dev', { cwd: '/home/user/s' });
  for (const path of [...dirs, ...objects]) assert.equal(kernel.stat(path).uid, CRED_SESSION_USER.uid, `${path} is handed to its user`);
  for (const path of runtimeStore) assert.equal(kernel.stat(path).uid, 0, `${path} stays the kernel's`);
  await runtime.exec('wrangler stop', { cwd: '/home/user/s' });
  console.log("  wrangler dev's stores, kept as root by earlier releases, are its user's");
}

// ── wrangler dev bundles through the view it is given ──────────────────────
{
  const builds = [];
  const files = new Map([['/home/user/app/wrangler.jsonc', JSON.stringify({ name: 'app', main: 'src/index.js', compatibility_date: '2026-09-26' })], ['/home/user/app/src/index.js', '']]);
  const bundleFs = { name: 'the launching process view' };
  const wrangler = new bundle.NimbusWrangler({
    vfs: { exists: (path) => files.has(`/${path}`), readFileString: (path) => files.get(`/${path}`) },
    bundleFs,
    namespace: { watchChanges: () => () => {} },
    esbuild: { build: async (entries, options) => { builds.push(options); return { errors: [{ text: 'stop here' }], warnings: [], outputFiles: [] }; } },
    env: {},
    ctx: {},
    network: { id: 'n' },
    root: '/home/user/app',
    onLog: () => {},
  });
  await wrangler.start().catch(() => false);
  assert.equal(builds.length, 1, 'one build');
  assert.equal(builds[0].fs, bundleFs, "the Worker's bundle reads through the view wrangler dev was given, not the build service's default");
  console.log('  wrangler dev bundles through the view it is given');
}

// ── a resident's boot reads its by-path images as the process ──────────────
{
  const manager = runtime.facets().manager;
  rootOnly('home/user/secret.wasm', '\0asm\x01\0\0\0');
  user.writeFile('home/user/own.wasm', '\0asm\x01\0\0\0');
  const entry = processes.spawn('node server.js', ['node', 'server.js'], '/home/user', { cred: CRED_SESSION_USER });
  const disk = manager._residentDisk(entry.pid);
  assert.equal((await disk.readFile('/home/user/own.wasm')).byteLength, 8, "the process's own image is read");
  await assert.rejects(async () => disk.readFile('/home/user/secret.wasm'), denied, 'an image its process cannot read is refused');
  console.log("  a resident's boot reads its by-path images as the process");
}

console.log('command-host-credential: ok');
