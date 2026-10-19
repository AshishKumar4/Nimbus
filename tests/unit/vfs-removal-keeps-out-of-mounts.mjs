#!/usr/bin/env bun
// A recursive removal keeps out of a mount point unless the mount asks to be
// crossed (Kinu ask 60). A mount is often storage that is not the session's:
// Kinu mounts the owner's machines, so `rm -r /machines` must not delete
// /home/owner/thesis.tex on a connected PC. The mount point and everything
// under it stay, reported EBUSY, and the rest of the tree goes, as GNU rm
// --one-file-system does; MountOptions.removalCrosses lets a mount be
// crossed as Linux's rm -r crosses one. The shell's rm goes through the same
// removal, and refuses `/` as GNU's --preserve-root does.
//
// Red before (core 0.19 to 0.24): removeRecursive entered the mounted tree
// and removed what it held, for both resolvesPaths values; rm -r had no
// --preserve-root.
import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { registerUnixCommands } from '../../packages/core/src/shell/unix-commands.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { testBox } from './lib/test-box.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const text = new TextEncoder();
const thesis = text.encode("the owner's work");

/** The workspace's tree, and a device's tree mounted inside it at /machines/laptop. */
async function machines(options) {
  const root = new MemoryVFS();
  await root.mkdir('/machines/laptop', { recursive: true });
  await root.writeFile('/machines/README', text.encode('beside the mount'));
  const device = new MemoryVFS();
  await device.mkdir('/home/owner', { recursive: true });
  await device.writeFile('/home/owner/thesis.tex', thesis);
  const namespace = new CompositeVFS(root);
  namespace.mount('/machines/laptop', device, options);
  return { root, device, namespace };
}
const present = async (vfs, path) => (await vfs.stat(path)) !== null;

for (const resolvesPaths of [false, true]) {
  const { device, namespace } = await machines({ resolvesPaths });
  const removal = await namespace.removeRecursive('/machines');
  assert.ok(await present(device, '/home/owner/thesis.tex'), `resolvesPaths=${resolvesPaths}: the device's file stays`);
  assert.deepEqual(removal.removed, ['/machines/README'], `resolvesPaths=${resolvesPaths}: only what is beside the mount goes`);
  assert.deepEqual(removal.kept, ['/machines', '/machines/laptop']);
  assert.deepEqual(removal.failures.map((f) => [f.path, f.error.code]), [['/machines/laptop', 'EBUSY']]);
  assert.equal(await present(namespace, '/machines/README'), false);

  // The mount point itself as the operand: nothing under it is touched.
  const own = await namespace.removeRecursive('/machines/laptop');
  assert.deepEqual([own.removed, own.failures.map((f) => [f.path, f.error.code])], [[], [['/machines/laptop', 'EBUSY']]]);
  assert.ok(await present(device, '/home/owner/thesis.tex'));
}

// A mount that asks to be crossed is, as Linux's rm -r crosses one; its mount point stays (EBUSY).
{
  const { device, namespace } = await machines({ removalCrosses: true });
  const removal = await namespace.removeRecursive('/machines');
  assert.equal(await present(device, '/home/owner/thesis.tex'), false, 'a crossing removal empties the mount');
  assert.deepEqual(removal.failures.map((f) => [f.path, f.error.code]), [['/machines/laptop', 'EBUSY']]);
}

// The shell's rm -r goes through the same removal.
{
  const harness = createSqliteVfsTestHarness();
  const store = new SqliteVFS(harness.sql, harness.ctx);
  store.as(CRED_KERNEL).mkdir('tmp', { mode: 0o1777 });
  store.as(CRED_KERNEL).chmod('tmp', 0o1777);
  const box = await testBox({ harness, vfs: store });
  registerUnixCommands(box.commands.registry, store);
  const device = new MemoryVFS();
  await device.mkdir('/home/owner', { recursive: true });
  await device.writeFile('/home/owner/thesis.tex', thesis);
  await box.commands.run('mkdir -p /tmp/machines/laptop && echo beside > /tmp/machines/README');
  box.files.vfs.mount('/tmp/machines/laptop', device);
  const rm = await box.commands.run('rm -r --one-file-system /tmp/machines; echo "status $?"; ls /tmp/machines');
  assert.equal(rm.stderr, "rm: cannot remove '/tmp/machines/laptop': Device or resource busy\n");
  assert.equal(rm.stdout, 'status 1\nlaptop\n');
  assert.ok(await present(device, '/home/owner/thesis.tex'), "the shell's rm keeps the device's file");

  // GNU's --preserve-root, the default: rm -r / is refused before anything is removed.
  const slash = await box.commands.run('rm -rf --preserve-root /; echo "status $?"; rm -rf /; echo "status $?"; ls -d /tmp');
  assert.equal(slash.stderr, "rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n".repeat(2));
  assert.equal(slash.stdout, 'status 1\nstatus 1\n/tmp\n');
}

console.log('vfs-removal-keeps-out-of-mounts: ok');
