import assert from 'node:assert/strict';
import { Nimbus } from '../../packages/sdk/src/sandbox.ts';
import { handleNimbusRemoteApi } from '../../packages/worker/src/router/remote-api.ts';
import { CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { programmaticHost } from './lib/programmatic-host.mjs';
import { processBridge } from './lib/process-bridge.mjs';

const box = await programmaticHost();
const fs = processBridge(box.ws.vfs, CRED_SESSION_USER);
const stub = {
  _rpcReady: async () => ({ ok: true, preinstalled: [] }),
  _rpcWriteFile: async (path, content) => fs.writeFile(path, content),
  _rpcStat: async (path) => fs.stat(path),
  _rpcLstat: async (path) => fs.stat(path, { followSymlinks: false }),
  _rpcReadlink: async (path) => fs.readlink(path),
};
const env = { NIMBUS_SESSION: { idFromName: (name) => name, get: () => stub } };
const remote = Nimbus.connect({ endpoint: 'https://files.test', fetch: async (url, init) =>
  handleNimbusRemoteApi(new Request(url, init), env, { remote: { enabled: true, allowLegacy: true } }),
}).sandbox('revision');
const local = Nimbus.fromEnv(env).sandbox('revision');
try {
  const path = '/home/user/file', link = '/home/user/link';
  await local.files.write(path, 'one');
  fs.symlink('file', link);
  const before = await remote.files.stat(path);
  await remote.files.write(path, 'two');
  fs.utimes(path, before.mtime, before.mtime);
  const after = await remote.files.stat(path);
  assert.equal(after.size, before.size);
  assert.equal(after.mtime, before.mtime);
  assert.ok(after.revision > before.revision, 'same-length writes and restoring timestamps cannot restore the old revision');
  assert.equal(after.ino, before.ino, 'writes retain the inode');
  assert.equal((await remote.files.lstat(link)).type, 'symlink');
  assert.notEqual((await remote.files.lstat(link)).ino, after.ino);
  assert.equal(await remote.files.readlink(link), 'file');
  assert.equal(await local.files.readlink(link), 'file');
} finally {
  await box.ws.close();
  box.close();
}
console.log('sdk-files-revision-readlink: colocated and remote metadata over the actual SQLite filesystem');
