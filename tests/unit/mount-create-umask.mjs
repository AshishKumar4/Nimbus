#!/usr/bin/env bun
// A file or directory a process makes on a mount whose backend takes no
// credential (MemoryVFS: the probe app's /mnt/data) is made with the
// process's umask applied, as on Linux, where the VFS applies it above every
// filesystem. A backend that takes a credential (the session's SQLite root)
// applies it itself. Every way a process makes one: through its bridge (an
// O_CREAT open, writeFile, mkdir, mkdir -p, a copy), through a wave, and
// through the namespace's synchronous face.

import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { asyncOnly } from './lib/async-memory-vfs.mjs';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const enc = new TextEncoder();
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const files = ws.filesystem;
ws.vfs.as(CRED_KERNEL).mkdir('home/user', { recursive: true });
ws.vfs.as(CRED_KERNEL).chown('home/user', 1000, 1000);

const failed = [];
const check = async (name, run) => {
  try {
    await run();
  } catch (error) {
    failed.push(`${name}: ${String(error?.message ?? error).split('\n').slice(0, 4).join(' | ')}`);
  }
};
const modeOf = async (bridge, path) => Number((await bridge.stat(path, { followSymlinks: false })).mode) & 0o7777;

const backends = { sync: new MemoryVFS({ uid: 1000, gid: 1000 }), async: new MemoryVFS({ uid: 1000, gid: 1000 }) };
files.vfs.mount('/s', backends.sync);
files.vfs.mount('/a', asyncOnly(backends.async, { deep: true }));

let pid = 9000;
for (const [face, at] of [['sync', '/s'], ['async', '/a'], ['session', '/home/user']]) {
  const proc = files.bind({ pid: ++pid, cred: USER });
  await check(`${face}: an O_CREAT open with mode 0666 makes 0644`, async () => {
    const opened = await proc.open(`${at}/opened`, { read: false, write: true, create: true, truncate: true, append: false, exclusive: false, directory: false, followSymlinks: true, sync: false, mode: 0o666 });
    await proc.close(opened.id);
    assert.equal(await modeOf(proc, `${at}/opened`), 0o644);
  });
  await check(`${face}: writeFile with mode 0666 makes 0644`, async () => {
    await proc.writeFile(`${at}/written`, enc.encode('x'), { mode: 0o666 });
    assert.equal(await modeOf(proc, `${at}/written`), 0o644);
  });
  await check(`${face}: mkdir with mode 0777 makes 0755`, async () => {
    await proc.mkdir(`${at}/made`, { mode: 0o777 });
    assert.equal(await modeOf(proc, `${at}/made`), 0o755);
  });
  await check(`${face}: mkdir -p with mode 0777 makes each 0755`, async () => {
    await proc.mkdir(`${at}/deep/er`, { recursive: true, mode: 0o777 });
    assert.equal(await modeOf(proc, `${at}/deep`), 0o755);
    assert.equal(await modeOf(proc, `${at}/deep/er`), 0o755);
  });
  await check(`${face}: a copy of a 0666 file makes 0644`, async () => {
    await proc.writeFile(`${at}/wide`, enc.encode('w'), { mode: 0o666 });
    await proc.chmod(`${at}/wide`, 0o666);
    await proc.copyFile(`${at}/wide`, `${at}/copied`);
    assert.equal(await modeOf(proc, `${at}/copied`), 0o644);
  });
  await check(`${face}: a wave's O_CREAT open with mode 0666 makes 0644`, async () => {
    const result = await proc.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops: [
      { type: 'call', call: { call: 'open', path: `${at.slice(1)}/waved`, mode: 0o666, umask: 0o022, access: 'write', create: true, truncate: true, description: 'w1' } },
      { type: 'call', call: { call: 'write', path: `${at.slice(1)}/waved`, description: 'w1', offset: 0, data: enc.encode('w') } },
      { type: 'call', call: { call: 'close', path: `${at.slice(1)}/waved`, description: 'w1' } },
    ] }));
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(await modeOf(proc, `${at}/waved`), 0o644);
  });
}

await check('the namespace\'s synchronous face makes 0644 on a mount', async () => {
  const view = files.vfs.as(USER);
  view.sync.writeFile('/s/synced', enc.encode('x'), { mode: 0o666 });
  assert.equal(Number(backends.sync.stat('/synced').mode) & 0o7777, 0o644);
});

if (failed.length > 0) {
  console.error(failed.join('\n'));
  process.exit(1);
}
console.log('mount-create-umask: ok');
