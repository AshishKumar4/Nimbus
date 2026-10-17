#!/usr/bin/env bun
// A durable worker's inline wasm module survives the session's restart.
//
// An embedder spawns a durable Worker-class program with an inline
// `{ wasm: ArrayBuffer }` module (the session's `_rpcSpawnWorker`). The launch
// is journalled and its inputs kept in the durable image store; a reset
// re-drives it from that image. The image kept the module as JSON, which
// writes an ArrayBuffer as `{}`: the first boot called into its wasm, and the
// restarted one could not compile it. Red before: the re-driven launch's
// module map held `{ wasm: {} }`.
//
// The world here compiles each `{ wasm }` member of a module map as workerd's
// loader does, and the program calls into the module as it boots and serves.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { DURABLE_IMAGE_DIR, persistDurableWorkerImage, resolveDurableWorkerImage } from '../../packages/worker/src/facets/durable-images.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { rpcSpawnWorker } from '../../packages/worker/src/session/programmatic.ts';
import { processHostFor } from '../../packages/worker/src/loaders/process-host.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { PID_GEN_STRIDE } from '../../packages/core/src/runtime/process-table.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { runColdStart } from '../../packages/fabric/src/generation.ts';
import { residentLoaderConfig } from '../../packages/fabric/src/process-fabric.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetCtx, createFacetWorld } from './lib/facet-host-harness.mjs';

adoptCtxExports({ SupervisorRPC: (opts) => ({ __supervisor: opts.props }) });

// (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const ADD_WASM = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00,
  0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
  0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
]);

// The program: its main module calls `add` from the inline `add.wasm`.
const world = createFacetWorld((config) => {
  // As workerd's loader does: each `{ wasm }` member is compiled with the map.
  const member = config.modules['add.wasm'];
  const add = new WebAssembly.Instance(new WebAssembly.Module(member.wasm)).exports.add;
  return {
    async startProcess() { return { ok: true, sum: add(2, 40) }; },
    async handleHttpRequest() { return Response.json({ sum: add(20, 22) }); },
  };
});

function session(storage, disk) {
  const lines = [];
  const ctx = createFacetCtx(world, 'durable-wasm-do', storage);
  const processes = new SessionProcessSupervisor();
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const fm = new FacetManager(ctx, { LOADER: world.loader }, processes, new PortRegistry(), processHostFor, {
    notify: (line) => lines.push(line),
    // The session's composition: a self-owned durable launch re-drives through the image store.
    resolveWorkerLaunchFallback: (recipe) => resolveDurableWorkerImage(vfs, recipe),
  });
  fm.setVfs(vfs, new ProcessFiles(vfs));
  // What `_rpcSpawnWorker` reaches through: the programmatic host over this manager.
  const host = { ensureRuntimeReady: async () => {}, ensureFacetManager: () => fm, facetManager: fm };
  return { ctx, fm, host, lines, processes };
}

const storage = new Map();
const disk = createSqliteVfsTestHarness();
const first = session(storage, disk);
const wasm = ADD_WASM.slice().buffer;
const spawned = await rpcSpawnWorker(first.host, 'export class NimbusProcess {}', 'wasm app', '/home/user', {
  modules: { 'add.wasm': { wasm } },
  durable: { owner: 'wasm-app' },
});
assert.deepEqual(spawned.boot, { ok: true, sum: 42 }, 'the first boot called into its wasm');

// The platform resets the session: the facet is lost, the object is new, and
// the journal and the image store are the ones the spawn wrote.
world.lose('app-slot-0');
const booted = world.boots.length;
const next = session(storage, disk);
next.processes.setPidBase(PID_GEN_STRIDE);
await runColdStart(next.ctx);
await Promise.all(next.ctx.waited);

assert.equal(world.boots.length, booted + 1, `the reset re-drove the launch: ${next.lines.join('')}`);
const reboot = world.boots.at(-1);
assert.equal(reboot.facetName, 'app-slot-0', 'the re-drive re-attached the durable facet');
const restored = reboot.config.modules['add.wasm'];
assert.ok(restored?.wasm instanceof ArrayBuffer, `the restored module is wasm bytes: ${JSON.stringify(restored)}`);
assert.deepEqual(new Uint8Array(restored.wasm), ADD_WASM, 'the restored module is the bytes the embedder spawned');
assert.deepEqual(await reboot.instance.startProcess(), { ok: true, sum: 42 }, 'the restarted program calls into its wasm');
assert.deepEqual(await (await reboot.instance.handleHttpRequest()).json(), { sum: 42 }, 'and serves through it');

// A text-only image is the JSON it always was, so its digest is the one an
// earlier release journalled. One that release wrote with a wasm module holds
// `{}` for its bytes: it is refused by name, never booted.
{
  const vfs = new SqliteVFS(disk.sql, disk.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  const blobs = {
    mkdirp: (dir) => kernel.mkdir(dir, { recursive: true, mode: 0o755 }),
    sizeOf: (path) => (kernel.exists(path) ? kernel.lstat(path).size : null),
    writeFile: (path, bytes) => kernel.writeFile(path, bytes, { mode: 0o644 }),
    writeRange: (path, offset, bytes) => kernel.writeRange(path, offset, bytes),
  };
  const sha256 = (text) => createHash('sha256').update(text).digest('hex');
  const text = await persistDurableWorkerImage(blobs, 'export default {}', { modules: { 'lib.js': 'export const v = 7;' } });
  assert.equal(text.application, sha256(JSON.stringify({ modules: { 'lib.js': 'export const v = 7;' }, env: null, vfsWasmModules: null })),
    'a text-only application image keeps its digest');

  const lossy = JSON.stringify({ modules: { 'add.wasm': { wasm: {} } }, env: null, vfsWasmModules: null });
  kernel.writeFile(`${DURABLE_IMAGE_DIR}/${sha256(lossy)}`, lossy);
  await assert.rejects(
    resolveDurableWorkerImage(vfs, { image: { runner: text.runner, application: sha256(lossy) } }),
    (error) => error.message.includes(`application image ${sha256(lossy)} cannot be restored`) && error.message.includes('add.wasm'),
    'an image that lost its wasm bytes is refused by name',
  );

  // Unless its by-path maps supply the module: the loader takes those in
  // place of an inline module of the same name, so such an image restarted
  // before and still does.
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.writeFile('home/user/add.wasm', ADD_WASM);
  const overridden = JSON.stringify({ modules: { 'add.wasm': { wasm: {} } }, env: null, vfsWasmModules: { 'add.wasm': '/home/user/add.wasm' } });
  kernel.writeFile(`${DURABLE_IMAGE_DIR}/${sha256(overridden)}`, overridden);
  const resolved = await resolveDurableWorkerImage(vfs, { image: { runner: text.runner, application: sha256(overridden) } });
  assert.equal(Object.hasOwn(resolved.modules, 'add.wasm'), false, 'the lost inline bytes are not handed on');
  const config = await residentLoaderConfig({
    compatibilityDate: '2026-04-01', compatibilityFlags: [], mainModule: resolved.mainModule,
    modules: resolved.modules, vfsWasmModules: resolved.vfsWasmModules,
  }, { readFile: (path) => kernel.readFile(path.replace(/^\/+/, '')) });
  const add = new WebAssembly.Instance(new WebAssembly.Module(config.modules['add.wasm'].wasm)).exports.add;
  assert.equal(add(40, 2), 42, 'the by-path module is the one the restarted program calls into');

  const textOverride = JSON.stringify({ modules: { 'lib.js': { wasm: {} } }, env: null, vfsWasmModules: null, vfsTextModules: { 'lib.js': '/home/user/lib.js' } });
  kernel.writeFile(`${DURABLE_IMAGE_DIR}/${sha256(textOverride)}`, textOverride);
  const textResolved = await resolveDurableWorkerImage(vfs, { image: { runner: text.runner, application: sha256(textOverride) } });
  assert.equal(Object.hasOwn(textResolved.modules, 'lib.js'), false, 'nor where a text module of its name stands in');
  assert.deepEqual(textResolved.vfsTextModules, { 'lib.js': '/home/user/lib.js' });
}

console.log('ok - durable inline wasm survives a re-drive from the image store');
