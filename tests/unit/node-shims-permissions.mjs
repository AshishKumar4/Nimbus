#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';

function createShim({
  cred = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  bundle = {},
  metadata = {},
  supervisor = null,
} = {}) {
  const factory = new Function(
    '__vfsBundle', '__vfsMetadata', '__vfsWrites', '__vfsDirs', '__vfsManifest',
    '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
    '"use strict"; let stdout = ""; let stderr = ""; let exitCode = 0; const __pendingIO = [];' +
      generateShimsCode() +
      '\n;return { fs: __fsMod, os: __osMod, process: __processMod, pendingIO: __pendingIO };',
  );
  return factory(
    bundle, metadata, {}, {}, {}, supervisor, cred,
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  );
}

function callbackResult(invoke) {
  return new Promise((resolve, reject) => {
    invoke((error, value) => error ? reject(error) : resolve(value));
  });
}

{
  const umasks = [];
  const shim = createShim({
    cred: { uid: 0, gid: 0, groups: [0, 44], umask: 0o027 },
    supervisor: { setUmask: async (mask) => { umasks.push(mask); } },
  });

  assert.equal(shim.process.getuid(), 0);
  assert.equal(shim.process.geteuid(), 0);
  assert.equal(shim.process.getgid(), 0);
  assert.equal(shim.process.getegid(), 0);
  assert.deepEqual(shim.process.getgroups(), [0, 44]);
  assert.deepEqual(shim.os.userInfo(), {
    uid: 0,
    gid: 0,
    username: 'root',
    homedir: '/root',
    shell: '/bin/sh',
  });

  assert.equal(shim.process.umask(), 0o027);
  assert.equal(shim.process.umask(0o077), 0o027);
  assert.equal(shim.process.umask(), 0o077);
  await Promise.allSettled(shim.pendingIO);
  assert.deepEqual(umasks, [0o077]);
}

{
  const calls = [];
  const supervisor = {
    stat: async () => ({
      type: 'file', size: 2, mode: 0o100640, uid: 1000, gid: 1000,
      atime: 1, mtime: 1, ctime: 1,
    }),
    chown: async (path, uid, gid, options) => {
      calls.push({ path, uid, gid, options });
    },
    access: async () => {},
  };
  const shim = createShim({ supervisor });

  await callbackResult((done) => shim.fs.chown('/home/user/file', 7, 8, done));
  await shim.fs.promises.lchown('/home/user/link', 9, 10);
  const handle = await shim.fs.promises.open('/home/user/file', 'r');
  await handle.chown(11, 12);
  await callbackResult((done) => shim.fs.fchown(handle.fd, 13, 14, done));
  await handle.close();

  assert.deepEqual(calls, [
    { path: '/home/user/file', uid: 7, gid: 8, options: undefined },
    { path: '/home/user/link', uid: 9, gid: 10, options: { followSymlinks: false } },
    { path: '/home/user/file', uid: 11, gid: 12, options: undefined },
    { path: '/home/user/file', uid: 13, gid: 14, options: undefined },
  ]);
}

{
  const denied = createShim({
    supervisor: {
      access: async () => { throw new Error('EACCES: permission denied'); },
    },
  });
  await assert.rejects(
    denied.fs.promises.access('/home/user/locked', denied.fs.constants.R_OK),
    (error) => {
      assert.equal(error.code, 'EACCES');
      assert.equal(error.errno, -13);
      assert.equal(error.syscall, 'access');
      assert.equal(error.path, '/home/user/locked');
      return true;
    },
  );

  const forbiddenChown = createShim({
    supervisor: {
      chown: async () => { throw new Error('EPERM: operation not permitted'); },
    },
  });
  await assert.rejects(
    forbiddenChown.fs.promises.chown('/home/user/file', 0, 0),
    (error) => {
      assert.equal(error.code, 'EPERM');
      assert.equal(error.errno, -1);
      assert.equal(error.syscall, 'chown');
      assert.equal(error.path, '/home/user/file');
      return true;
    },
  );
}

{
  const shim = createShim({
    bundle: {
      'home/user/readable': 'ok',
      'home/user/locked': { error: 'EACCES' },
    },
    metadata: {
      'home/user/readable': { type: 'file', size: 2, mode: 0o100640, uid: 1000, gid: 1000 },
      'home/user/locked': { type: 'file', size: 6, mode: 0o100000, uid: 0, gid: 0 },
    },
  });

  const stat = shim.fs.statSync('/home/user/readable');
  assert.equal(stat.mode, 0o100640);
  assert.equal(stat.uid, 1000);
  assert.equal(stat.gid, 1000);
  assert.doesNotThrow(() => shim.fs.accessSync('/home/user/readable', shim.fs.constants.R_OK));
  assert.equal(shim.fs.existsSync('/home/user/locked'), true);
  const lockedStat = shim.fs.statSync('/home/user/locked');
  assert.equal(lockedStat.mode, 0o100000);
  assert.equal(lockedStat.uid, 0);
  assert.equal(lockedStat.gid, 0);
  assert.throws(
    () => shim.fs.readFileSync('/home/user/locked'),
    (error) => error.code === 'EACCES' && error.errno === -13 && error.path === '/home/user/locked',
  );
  assert.throws(
    () => shim.fs.accessSync('/home/user/locked', shim.fs.constants.R_OK),
    (error) => error.code === 'EACCES' && error.errno === -13,
  );
  assert.throws(
    () => shim.fs.readFileSync('/home/user/missing'),
    (error) => error.code === 'ENOENT' && error.errno === -2,
  );
}

{
  const metadata = {
    home: { type: 'directory', mode: 0o40755, uid: 0, gid: 0 },
    'home/user': { type: 'directory', mode: 0o40755, uid: 1000, gid: 1000 },
    'home/user/root-owned': { type: 'file', size: 4, mode: 0o100644, uid: 0, gid: 0 },
    'home/user/user-owned': { type: 'file', size: 4, mode: 0o100644, uid: 1000, gid: 1000 },
    'home/user/locked': { type: 'directory', size: 0, mode: 0o40555, uid: 0, gid: 0 },
  };
  const bundle = {
    'home/user/root-owned': 'root',
    'home/user/user-owned': 'user',
  };
  const user = createShim({ bundle: { ...bundle }, metadata });

  for (const write of [
    () => user.fs.writeFileSync('/home/user/root-owned', 'changed'),
    () => user.fs.appendFileSync('/home/user/root-owned', 'changed'),
  ]) {
    assert.throws(write, (error) => {
      assert.equal(error.code, 'EACCES');
      assert.equal(error.errno, -13);
      assert.equal(error.syscall, 'open');
      assert.equal(error.path, '/home/user/root-owned');
      return true;
    });
  }
  assert.equal(user.fs.readFileSync('/home/user/root-owned', 'utf8'), 'root', 'denied sync writes do not mutate the local view');
  assert.throws(
    () => user.fs.writeFileSync('/home/user/locked/new', 'x'),
    (error) => error.code === 'EACCES' && error.errno === -13 && error.syscall === 'open',
    'creating a file requires write and search permission on its parent',
  );
  assert.doesNotThrow(() => user.fs.writeFileSync('/home/user/user-owned', 'changed'));
  assert.equal(user.fs.readFileSync('/home/user/user-owned', 'utf8'), 'changed');

  assert.equal(typeof user.fs.appendFile, 'function');
  await assert.rejects(
    callbackResult((done) => user.fs.appendFile('/home/user/root-owned', 'x', done)),
    (error) => error.code === 'EACCES' && error.errno === -13 && error.syscall === 'open',
  );

  const root = createShim({
    cred: { uid: 0, gid: 0, groups: [0], umask: 0o022 },
    bundle: { ...bundle },
    metadata,
  });
  assert.doesNotThrow(() => root.fs.writeFileSync('/home/user/root-owned', 'changed'));
  assert.doesNotThrow(() => root.fs.appendFileSync('/home/user/root-owned', ' again'));
}

{
  const shim = createShim({
    metadata: {
      home: { type: 'directory', mode: 0o40755, uid: 0, gid: 0 },
      'home/user': { type: 'directory', mode: 0o40755, uid: 1000, gid: 1000 },
      'home/user/private': { type: 'directory', mode: 0o40700, uid: 0, gid: 0 },
      'home/user/private/leaf': { type: 'file', size: 6, mode: 0o100644, uid: 0, gid: 0 },
    },
  });

  for (const read of [
    () => shim.fs.statSync('/home/user/private/leaf'),
    () => shim.fs.readFileSync('/home/user/private/leaf'),
    () => shim.fs.readdirSync('/home/user/private'),
  ]) {
    assert.throws(read, (error) => error.code === 'EACCES' && error.errno === -13);
  }
  assert.equal(shim.fs.statSync('/home/user/private').isDirectory(), true, 'stat of the directory itself only traverses its parent');
  assert.throws(
    () => shim.fs.statSync('/home/user/missing'),
    (error) => error.code === 'ENOENT' && error.errno === -2,
  );

  await assert.rejects(shim.fs.promises.stat('/home/user/private/leaf'), (error) => error.code === 'EACCES');
  await assert.rejects(shim.fs.promises.readFile('/home/user/private/leaf'), (error) => error.code === 'EACCES');
  await assert.rejects(shim.fs.promises.readdir('/home/user/private'), (error) => error.code === 'EACCES');
}

console.log('node-shims-permissions: all assertions passed');
