#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { _rpcLstat, _rpcUnlink } from '../../packages/worker/src/session/rpc.ts';
import { rpcDestroy } from '../../packages/worker/src/session/programmatic.ts';

{
  let call;
  const vfs = {
    isSymlink: () => false,
    exists: () => true,
    stat(path) {
      call = { path, options: { followSymlinks: false } };
      return { type: 'symlink', size: 6, mode: 0o777, uid: 1000, gid: 1000 };
    },
    lstat(path) {
      call = { path, options: { followSymlinks: false } };
      return { type: 'symlink', size: 6, mode: 0o777, uid: 1000, gid: 1000 };
    },
  };
  const result = await _rpcLstat({
    ensureSqliteFs() {},
    processes: { cred: () => CRED_KERNEL },
    sqliteFs: {
      as: () => vfs,
      revision: () => 0,
    },
  }, '/home/user/link', 1);
  assert.equal(result.type, 'symlink');
  assert.deepEqual(call, {
    path: 'home/user/link',
    options: { followSymlinks: false },
  });
}

{
  await assert.rejects(
    _rpcUnlink({
      ensureSqliteFs() {},
      processes: { cred: () => CRED_KERNEL },
      sqliteFs: {
        as: () => ({}),
        assertMutationAllowed() {
          throw new Error('EBUSY: clone destination is exclusively locked');
        },
      },
    }, '/home/user/repo/file', 1),
    /EBUSY/,
    'unlink must not swallow the exclusive-mutation failure',
  );
}

{
  await assert.rejects(
    rpcDestroy({
      ensureSqliteFs() {},
      sqliteFs: { hasExclusiveMutation: () => true },
    }),
    /EBUSY: session has an active exclusive filesystem mutation/,
  );
}

{
  let guardActive = false;
  let releases = 0;
  const self = {
    sqliteFs: null,
    ensureSqliteFs() {
      if (this.sqliteFs) return;
      this.sqliteFs = {
        hasExclusiveMutation: () => false,
        acquireGlobalExclusiveMutation() {
          guardActive = true;
          return { root: '', owner: 'destroy-owner' };
        },
        releaseExclusiveMutation(owner) {
          assert.equal(owner, 'destroy-owner');
          guardActive = false;
          releases++;
        },
      };
    },
    processes: { getAll: () => [], flushLogs() {} },
    portRegistry: {},
    ctx: {
      getWebSockets: () => [],
      storage: {
        async deleteAll() { assert.equal(guardActive, true); },
        async deleteAlarm() {},
        async put() {},
      },
    },
  };
  const result = await rpcDestroy(self);
  assert.equal(result.ok, true);
  assert.equal(guardActive, true, 'successful destroy released its stale-VFS reservation');
  assert.equal(releases, 0);
}

{
  let guardActive = false;
  let releases = 0;
  const self = {
    ensureSqliteFs() {},
    sqliteFs: {
      hasExclusiveMutation: () => false,
      acquireGlobalExclusiveMutation() {
        guardActive = true;
        return { root: '', owner: 'destroy-owner' };
      },
      releaseExclusiveMutation() {
        guardActive = false;
        releases++;
      },
    },
    processes: { getAll: () => [], flushLogs() {} },
    portRegistry: {},
    ctx: {
      getWebSockets: () => [],
      storage: { async deleteAll() { throw new Error('injected destroy failure'); } },
    },
  };
  await assert.rejects(rpcDestroy(self), /injected destroy failure/);
  assert.equal(guardActive, false);
  assert.equal(releases, 1, 'failed destroy did not release its reservation');
}

console.log('session exclusive mutation RPC: ok');
