#!/usr/bin/env bun
// The process's identity and the permissions the session applies to what it
// asks, as the program sees them: the identity and umask it runs with, the
// owner and group a chown sets, and each refusal (EACCES, EPERM) the
// authority's permission decisions give, sync and async alike. Each case is a
// process of its own over the real session (runScenarios).

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createAuthority, runScenarios } from './lib/resident-body.mjs';
import { USER, shimsOnSession } from './lib/shims-on-session.mjs';

const ROOT = Object.freeze({ uid: 0, gid: 0, groups: Object.freeze([0]), umask: 0o022 });

function callbackResult(invoke) {
  return new Promise((resolve, reject) => {
    invoke((error, value) => error ? reject(error) : resolve(value));
  });
}

/** A process of `cred` over a new session, whose tree `seed` makes as the kernel does (before the listing). */
function sessionFor(cred, { seed = () => {}, overrides = {}, bundle = {} } = {}) {
  const authority = createAuthority();
  seed(authority.rawVfs.as(CRED_KERNEL));
  return { authority, ...shimsOnSession({ authority, cred, overrides, bundle }) };
}

const scenarios = {
  async 'the identity a process runs as, and its umask, are the program\'s'() {
    const umasks = [];
    const { process: proc, os, pendingIO } = sessionFor({ uid: 0, gid: 0, groups: [0, 44], umask: 0o027 }, {
      overrides: { setUmask: async (mask) => { umasks.push(mask); } },
    });
    assert.equal(proc.getuid(), 0);
    assert.equal(proc.geteuid(), 0);
    assert.equal(proc.getgid(), 0);
    assert.equal(proc.getegid(), 0);
    assert.deepEqual(proc.getgroups(), [0, 44]);
    assert.deepEqual(os.userInfo(), {
      uid: 0,
      gid: 0,
      username: 'root',
      homedir: '/root',
      shell: '/bin/sh',
    });

    assert.equal(proc.umask(), 0o027);
    assert.equal(proc.umask(0o077), 0o027);
    assert.equal(proc.umask(), 0o077);
    await Promise.allSettled(pendingIO);
    assert.deepEqual(umasks, [0o077]);
  },

  async 'chown, fchown and lchown set the owner and group the session holds'() {
    const { authority, fs } = sessionFor(ROOT, {
      seed: (kernel) => {
        kernel.writeFile('home/user/file', 'data');
        kernel.chown('home/user/file', 1000, 1000);
        kernel.symlink('/home/user/file', 'home/user/link');
      },
    });
    await callbackResult((done) => fs.chown('/home/user/file', 7, 8, done));
    await fs.promises.lchown('/home/user/link', 9, 10);
    const handle = await fs.promises.open('/home/user/file', 'r');
    await handle.chown(11, 12);
    await callbackResult((done) => fs.fchown(handle.fd, 13, 14, done));
    await handle.close();
    // The file's last owner and group are fchown's; the link's are lchown's own.
    const file = await authority.peer.lstat('/home/user/file');
    assert.deepEqual([file.uid, file.gid], [13, 14]);
    const link = await authority.peer.lstat('/home/user/link');
    assert.deepEqual([link.uid, link.gid], [9, 10]);
    assert.equal(link.type, 'symlink');
  },

  async 'an access the session denies is EACCES in the program'() {
    const { fs } = sessionFor(USER, {
      seed: (kernel) => {
        kernel.writeFile('home/user/locked', 'secret');
        kernel.chmod('home/user/locked', 0o000);
      },
    });
    await assert.rejects(fs.promises.access('/home/user/locked', fs.constants.R_OK), (error) => {
      assert.equal(error.code, 'EACCES');
      assert.equal(error.errno, -13);
      assert.equal(error.syscall, 'access');
      assert.equal(error.path, '/home/user/locked');
      return true;
    });
  },

  async 'a chown the session refuses is EPERM in the program'() {
    const { fs } = sessionFor(USER, {
      seed: (kernel) => { kernel.writeFile('home/user/file', 'data'); kernel.chown('home/user/file', 1000, 1000); },
    });
    await assert.rejects(fs.promises.chown('/home/user/file', 0, 0), (error) => {
      assert.equal(error.code, 'EPERM');
      assert.equal(error.errno, -1);
      assert.equal(error.syscall, 'chown');
      assert.equal(error.path, '/home/user/file');
      return true;
    });
  },

  'a mode the session states decides what the process reads, and what it is told'() {
    const { fs } = sessionFor(USER, {
      seed: (kernel) => {
        kernel.writeFile('home/user/readable', 'ok');
        kernel.chown('home/user/readable', 1000, 1000);
        kernel.chmod('home/user/readable', 0o640);
        kernel.writeFile('home/user/locked', 'secret');
        kernel.chmod('home/user/locked', 0o000);
      },
      bundle: { 'home/user/readable': 'ok' },
    });

    const stat = fs.statSync('/home/user/readable');
    assert.equal(stat.mode, 0o100640);
    assert.equal(stat.uid, 1000);
    assert.equal(stat.gid, 1000);
    assert.doesNotThrow(() => fs.accessSync('/home/user/readable', fs.constants.R_OK));
    assert.equal(fs.existsSync('/home/user/locked'), true);
    const lockedStat = fs.statSync('/home/user/locked');
    assert.equal(lockedStat.mode, 0o100000);
    assert.equal(lockedStat.uid, 0);
    assert.equal(lockedStat.gid, 0);
    assert.throws(
      () => fs.readFileSync('/home/user/locked'),
      (error) => error.code === 'EACCES' && error.errno === -13 && error.path === '/home/user/locked',
    );
    assert.throws(
      () => fs.accessSync('/home/user/locked', fs.constants.R_OK),
      (error) => error.code === 'EACCES' && error.errno === -13,
    );
    assert.throws(
      () => fs.readFileSync('/home/user/missing'),
      (error) => error.code === 'ENOENT' && error.errno === -2,
    );
  },

  async 'a write needs the file\'s permission, and its directory\'s for a new file'() {
    const { fs } = sessionFor(USER, {
      seed: (kernel) => {
        kernel.writeFile('home/user/root-owned', 'root');
        kernel.writeFile('home/user/user-owned', 'user');
        kernel.chown('home/user/user-owned', 1000, 1000);
        kernel.mkdir('home/user/locked', { mode: 0o555 });
      },
      bundle: { 'home/user/root-owned': 'root', 'home/user/user-owned': 'user' },
    });

    for (const write of [
      () => fs.writeFileSync('/home/user/root-owned', 'changed'),
      () => fs.appendFileSync('/home/user/root-owned', 'changed'),
    ]) {
      assert.throws(write, (error) => {
        assert.equal(error.code, 'EACCES');
        assert.equal(error.errno, -13);
        assert.equal(error.syscall, 'open');
        assert.equal(error.path, '/home/user/root-owned');
        return true;
      });
    }
    assert.equal(fs.readFileSync('/home/user/root-owned', 'utf8'), 'root', 'denied sync writes do not mutate the local view');
    assert.throws(
      () => fs.writeFileSync('/home/user/locked/new', 'x'),
      (error) => error.code === 'EACCES' && error.errno === -13 && error.syscall === 'open',
      'creating a file requires write and search permission on its parent',
    );
    assert.doesNotThrow(() => fs.writeFileSync('/home/user/user-owned', 'changed'));
    assert.equal(fs.readFileSync('/home/user/user-owned', 'utf8'), 'changed');

    assert.equal(typeof fs.appendFile, 'function');
    await assert.rejects(
      callbackResult((done) => fs.appendFile('/home/user/root-owned', 'x', done)),
      (error) => error.code === 'EACCES' && error.errno === -13 && error.syscall === 'open',
    );
  },

  'a root process writes what its owner did not allow'() {
    const { fs } = sessionFor(ROOT, {
      seed: (kernel) => { kernel.writeFile('home/user/root-owned', 'root'); },
      bundle: { 'home/user/root-owned': 'root' },
    });
    assert.doesNotThrow(() => fs.writeFileSync('/home/user/root-owned', 'changed'));
    assert.doesNotThrow(() => fs.appendFileSync('/home/user/root-owned', ' again'));
  },

  async 'a directory the process may not search denies what lies beneath it'() {
    const { fs } = sessionFor(USER, {
      seed: (kernel) => {
        kernel.mkdir('home/user/private', { mode: 0o700 });
        kernel.writeFile('home/user/private/leaf', 'secret');
      },
    });
    for (const read of [
      () => fs.statSync('/home/user/private/leaf'),
      () => fs.readFileSync('/home/user/private/leaf'),
      () => fs.readdirSync('/home/user/private'),
    ]) {
      assert.throws(read, (error) => error.code === 'EACCES' && error.errno === -13);
    }
    assert.equal(fs.statSync('/home/user/private').isDirectory(), true, 'stat of the directory itself only traverses its parent');
    assert.throws(
      () => fs.statSync('/home/user/missing'),
      (error) => error.code === 'ENOENT' && error.errno === -2,
    );

    await assert.rejects(fs.promises.stat('/home/user/private/leaf'), (error) => error.code === 'EACCES');
    await assert.rejects(fs.promises.readFile('/home/user/private/leaf'), (error) => error.code === 'EACCES');
    await assert.rejects(fs.promises.readdir('/home/user/private'), (error) => error.code === 'EACCES');
  },
};

await runScenarios(import.meta.path, scenarios);
