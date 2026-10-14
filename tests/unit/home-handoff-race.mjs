#!/usr/bin/env bun
// A home is handed to its user in a way no one else can redirect. Root makes
// a home's directories only below directories no one but root may change,
// and hands over the last one there. Below one the user may write, the user
// makes the rest itself, so nothing is chowned by root at a name the user
// could have replaced since it was made.
//
// The race is played out at the one moment it can happen: just before root's
// chown of the new home, the user moves the new directory aside and puts a
// link to a root-owned directory at its name (as a writer of an asynchronous
// mount could, between two seed steps). Red before: root made the home under
// the user's /home/user and chowned it by name, following that link, and
// handed the user /etc/victim.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { seedBaseFilesystem } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = CRED_SESSION_USER.uid;

/** `vfs`, but each chown root makes at `at` is raced first by `race`. */
function racing(vfs, at, race) {
  return new Proxy(vfs, {
    get(target, name) {
      if (name !== 'as') {
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (cred) => {
        const view = target.as(cred);
        if (cred.uid !== 0) return view;
        return new Proxy(view, {
          get(v, key) {
            const value = Reflect.get(v, key, v);
            if (key !== 'chown') return typeof value === 'function' ? value.bind(v) : value;
            return (path, ...rest) => {
              if (path === at) race();
              return value.call(v, path, ...rest);
            };
          },
        });
      };
    },
  });
}

for (const [home, parentIsUsers] of [['/home/user/sub', true], ['/srv/home', false]]) {
  const harness = createSqliteVfsTestHarness();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  seedBaseFilesystem(vfs);
  const kernel = vfs.as(CRED_KERNEL);
  const user = vfs.as(CRED_SESSION_USER);
  kernel.mkdir('etc/victim', { mode: 0o755 });
  const key = home.slice(1);
  let raced = false;
  seedBaseFilesystem(racing(vfs, key, () => {
    // The user's move: possible only where it may write the home's parent.
    try {
      user.rename(key, `${key}-moved`);
      user.symlink('/etc/victim', key);
      raced = true;
    } catch (error) {
      if (error?.code !== 'EACCES') throw error;
    }
  }), home);
  assert.equal(kernel.lstat('etc/victim').uid, 0, `${home}: no root-owned directory is handed to the user`);
  const made = kernel.lstat(key);
  if (!raced) {
    assert.equal(made.type, 'directory', `${home}: the home is made`);
    assert.equal(made.uid, USER, `${home}: and is the user's`);
  }
  if (parentIsUsers) assert.equal(raced, false, `${home}: below the user's own directory, root chowns nothing the user could replace`);
  else assert.equal(kernel.lstat(key.split('/')[0]).uid, 0, `${home}: its parent stays root's`);
}

console.log('home-handoff-race: ok');
