import assert from 'node:assert/strict';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { programmaticHost } from './lib/programmatic-host.mjs';
import { sessionFileStatOf } from '../../packages/core/src/runtime/session-protocol.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';

const box = await programmaticHost();
const lease = box.ws.filesystem.openHost(CRED_SESSION_USER);
const fs = lease.fs;
const stub = {
  _rpcReady: async () => ({ ok: true, preinstalled: [] }),
  _rpcWriteFile: async (path, content) => fs.writeFile(path, content),
  _rpcStat: async (path) => sessionFileStatOf(await fs.stat(path)),
  _rpcLstat: async (path) => sessionFileStatOf(await fs.stat(path, { followSymlinks: false })),
  _rpcReadlink: async (path) => fs.readlink(path),
};
const env = { NIMBUS_SESSION: { idFromName: (name) => name, get: () => stub } };
const remote = Nimbus.connect({ endpoint: 'https://files.test', fetch: async (url, init) =>
  handleNimbusRemoteApi(new Request(url, init), env, { remote: { enabled: true, allowLegacy: true } }),
}).sandbox('revision');
const local = Nimbus.fromEnv(env).sandbox('revision');
try {
  const path = '/home/user/file', link = '/home/user/link';
  const realNow = Date.now;
  const fixedTime = realNow();
  let before;
  try {
    Date.now = () => fixedTime;
    await local.files.write(path, 'one');
    await fs.symlink('file', link);
    before = await remote.files.stat(path);
    await remote.files.write(path, 'two');
    const second = await remote.files.stat(path);
    assert.equal(second.mtime, before.mtime, 'same millisecond');
    assert.ok(second.revision > before.revision, 'two same-length writes in one millisecond have distinct revisions');
  } finally { Date.now = realNow; }
  await fs.utimes(path, before.mtime, before.mtime);
  const after = await remote.files.stat(path);
  assert.equal(after.size, before.size);
  assert.equal(after.mtime, before.mtime);
  assert.ok(after.revision > before.revision, 'same-length writes and restoring timestamps cannot restore the old revision');
  assert.equal(after.ino, before.ino, 'writes retain the inode');
  assert.equal((await remote.files.lstat(link)).type, 'symlink');
  assert.notEqual((await remote.files.lstat(link)).ino, after.ino);
  assert.equal(await remote.files.readlink(link), 'file');
  assert.equal(await local.files.readlink(link), 'file');
  const mounted = new MemoryVFS(CRED_SESSION_USER);
  mounted.writeFile('/file', new TextEncoder().encode('mounted'));
  const backend = (metadata) => ({
    stat(path, options) {
      const stat = mounted.stat(path, options);
      if (stat === null) return null;
      const { ino, revision, ...fields } = stat;
      return { ...fields, ...metadata };
    },
    readFile: mounted.readFile.bind(mounted), writeFile: mounted.writeFile.bind(mounted),
    readdir: mounted.readdir.bind(mounted), mkdir: mounted.mkdir.bind(mounted), unlink: mounted.unlink.bind(mounted),
  });
  box.ws.filesystem.vfs.mount('/plain', backend({}));
  box.ws.filesystem.vfs.mount('/stamped', backend({ ino: 123, revision: 23 }));
  const plain = await remote.files.stat('/plain/file');
  assert.ok(plain.ino > 0, 'the namespace numbers entries when a backend does not number its own inodes');
  assert.equal((await remote.files.stat('/plain/file')).ino, plain.ino, 'the namespace inode is stable while the backend stays mounted');
  assert.equal(Object.hasOwn(plain, 'revision'), false, 'an unstamped mount reports no invented revision');
  const stamped = await remote.files.stat('/stamped/file');
  assert.equal(stamped.ino, 123);
  assert.equal(stamped.revision, 23, 'a mounted backend numeric revision survives the namespace and wire');
} finally {
  await lease.dispose();
  await box.ws.close();
  box.close();
}
console.log('sdk-files-revision-readlink: colocated and remote metadata over the actual SQLite filesystem');
