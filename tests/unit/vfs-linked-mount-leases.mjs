#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { testBox } from './lib/test-box.mjs';

const box = await testBox({ mounts: { '/m': new MemoryVFS({ uid: 1000, gid: 1000 }) } });
try {
  const view = box.workspace.shell.getVfs();
  await view.mkdir('/m/leased');
  await view.writeFile('/m/leased/f', 'file');
  await view.symlink('/m', '/home/user/alias');
  const lease = box.files.engine.acquireExclusiveMutation('m/leased');
  try {
    for (const [from, to] of [['/m/leased/f', '/m/leased/g'], ['/home/user/alias/leased/f', '/home/user/alias/leased/g']]) {
      let refused;
      try { await view.rename(from, to); } catch (error) { refused = error; }
      assert.equal(refused?.code, 'EBUSY', `${from}: ${refused?.stack}\n${refused?.cause?.stack}`);
    }
    assert.equal((await view.readFile('/m/leased/f')).length, 4);
  } finally { box.files.engine.releaseExclusiveMutation(lease.owner); }
  await view.rename('/home/user/alias/leased/f', '/home/user/alias/leased/g');
  assert.equal((await view.readFile('/m/leased/g')).length, 4);
} finally { await box.workspace.close(); }
console.log('vfs-linked-mount-leases: ok');
