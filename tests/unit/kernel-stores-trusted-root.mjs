#!/usr/bin/env bun
// The kernel's own stores — the images a resident process boots from, the
// session's copies of inline wasm and of staged native bindings — are reached
// through no directory a user may replace. They live below `/.nimbus`: `/` is
// root's 0755, so no user can make, rename or remove a name in it, and the
// kernel checks that `/.nimbus` is its own real directory before it writes.
// Red before: they lived below `/var`, which the session's user owns, so a
// user who moved `/var/lib` aside and put a link at `/var/lib/nimbus/<store>`
// had the kernel write its images into any directory, and the image sweep
// unlink, as root, every name there it did not recognise.

import assert from 'node:assert/strict';
import { FacetManager } from '../../packages/worker/src/facets/manager.ts';
import { PortRegistry } from '../../packages/core/src/runtime/port-registry.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { seedBaseFilesystem } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { STAGED_BINDINGS } from '../../packages/worker/src/runtime/staged-bindings.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createFacetWorld, createFacetCtx, captureProcessBoots } from './lib/facet-host-harness.mjs';
import { processFiles } from './lib/process-bridge.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

adoptCtxExports({ SupervisorRPC: ({ props }) => ({ props }) });

/** A session on the OS it boots on (`/var` is its user's), and a manager writing its stores. */
function session(name) {
  const world = createFacetWorld(() => ({
    async startProcess() { return { ok: true }; },
    async handleHttpRequest() { return new Response('ok'); },
  }));
  const processes = new SessionProcessSupervisor();
  const manager = new FacetManager(
    createFacetCtx(world, name), { LOADER: world.loader, ASSETS: stagedAssets }, processes, new PortRegistry(), captureProcessBoots(world), {},
  );
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  seedBaseFilesystem(vfs);
  const files = processFiles(vfs);
  manager.setVfs(vfs, files);
  const kernel = vfs.as(CRED_KERNEL);
  const user = vfs.as(CRED_SESSION_USER);
  // A directory only root may change, holding a file the user may not remove.
  kernel.mkdir('etc/victim', { mode: 0o755 });
  kernel.writeFile('etc/victim/keep', 'keep', { mode: 0o644 });
  const victim = () => kernel.readdir('etc/victim').map((entry) => entry.name).sort();
  const spawn = (code, file) => manager.spawnNode(code, { command: `node ${file}`, filename: `/home/user/${file}`, cwd: '/home/user' });
  const pid = processes.spawn('node', ['node'], '/home/user').pid;
  return { world, manager, kernel, user, victim, spawn, pid, files, processes };
}
const pacer = { chunks: 0, async spend() {} };
const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

// ── a link the user put where a store was is not followed ──────────────────
{
  const { manager, kernel, user, victim, spawn, pid, world } = session('kernel-stores-links');
  // The user moves the kernel's /var/lib aside (it owns /var) and makes its own.
  if (kernel.exists('var/lib')) user.rename('var/lib', 'var/lib-old');
  user.mkdir('var/lib/nimbus', { recursive: true });
  for (const store of ['facet-images', 'inline-wasm', 'staged']) user.symlink('/etc/victim', `var/lib/nimbus/${store}`);

  await spawn('const a = 1;', 'a.js');
  await spawn('const b = 2;', 'b.js');
  manager._stageWasmImageBytes([wasm], pid);
  await manager._residentStagedBindingMembers([STAGED_BINDINGS[0].key], pid, pacer);
  assert.deepEqual(victim(), ['keep'], 'the kernel wrote nothing through the link, and removed nothing there');

  const image = world.bootSpecs.at(-1).code.vfsComposedModules['worker.js'];
  assert.match(image, /^\/\.nimbus\/process-images\/[0-9a-f]{64}\.js$/, 'the images are below /.nimbus');
  const root = kernel.lstat('.nimbus');
  assert.equal(root.type, 'directory');
  assert.equal(root.uid, 0, '/.nimbus is the kernel’s');
  assert.equal(root.mode & 0o022, 0, 'and no one else may write it');
  console.log('  a link the user put where a store was is not followed');
}

// ── an earlier release's stores below /var are left as they were ─────────
// A durable worker an earlier release made may still boot from a path there,
// and a root-owned directory at that name is not proof the kernel made it:
// the user may have moved another of root's trees there. Nothing is removed.
{
  const { kernel, spawn } = session('kernel-stores-legacy');
  const legacy = ['var/lib/nimbus/facet-images', 'var/lib/nimbus/inline-wasm', 'var/lib/nimbus/staged/a/1'];
  for (const dir of legacy) kernel.mkdir(dir, { recursive: true, mode: 0o755 });
  const old = [`var/lib/nimbus/facet-images/${'0'.repeat(64)}.js`, 'var/lib/nimbus/inline-wasm/sha256-0.wasm', 'var/lib/nimbus/staged/a/1/a.wasm'];
  for (const file of old) kernel.writeFile(file, 'old', { mode: 0o644 });
  await spawn('const a = 1;', 'a.js');
  for (const file of old) assert.equal(kernel.exists(file), true, `${file} is left`);
  console.log("  an earlier release's stores below /var are left as they were");
}

// ── a delegation of /var holds up no store ────────────────────────────────
// /var is the user's: a process may hold it, and the kernel's stores are not there.
{
  const { files, processes, manager, pid } = session('kernel-stores-var-delegation');
  const holder = processes.spawn('git', ['git'], '/home/user').pid;
  files.bind({ pid: holder, cred: CRED_SESSION_USER }).acquireExclusiveMutation('/var', { delegate: { reads: true } });
  assert.equal(manager._stageWasmImageBytes([wasm], pid).length, 1, 'an inline wasm image is staged');
  assert.notEqual(await manager._residentStagedBindingMembers([STAGED_BINDINGS[0].key], pid, pacer), null, 'and a staged binding');
  console.log('  a delegation of /var holds up no store');
}

// ── a /.nimbus that is not the kernel's own directory is refused ───────────
{
  const { kernel, victim, spawn } = session('kernel-stores-root');
  // Only root can put a name in /: here, as if through sudo.
  kernel.symlink('/etc/victim', '.nimbus');
  await assert.rejects(spawn('const a = 1;', 'a.js'), /\/\.nimbus/, 'a launch whose store root is a link fails, naming it');
  assert.deepEqual(victim(), ['keep'], 'and writes nothing through it');
  console.log('  a /.nimbus that is not the kernel’s own directory is refused');
}

console.log('kernel-stores-trusted-root: ok');
