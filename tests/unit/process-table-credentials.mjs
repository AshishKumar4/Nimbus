#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { ProcessTable } from '../../packages/worker/src/runtime/process-table.ts';

const USER_CRED = {
  uid: 1000,
  gid: 1000,
  groups: [1000],
  umask: 0o022,
};

const table = new ProcessTable();

const login = table.spawn('sh', ['sh'], '/home/user');
assert.deepEqual(login.cred, USER_CRED, 'processes default to the session user');
assert.deepEqual(table.credOf(login.pid), USER_CRED);

const root = table.spawn('sudo', ['sudo', 'sh'], '/home/user', { cred: CRED_KERNEL });
assert.deepEqual(root.cred, CRED_KERNEL, 'an explicitly elevated process runs as root');

table.setUmask(login.pid, 0o077);
assert.equal(table.credOf(login.pid).umask, 0o077, 'umask changes the invoking process');

const child = table.spawn('node', ['child.js'], '/home/user', { parentPid: login.pid });
assert.deepEqual(child.cred, {
  uid: 1000,
  gid: 1000,
  groups: [1000],
  umask: 0o077,
}, 'spawn inherits a copy of its parent credential and umask');

table.setUmask(child.pid, 0o002);
assert.equal(table.credOf(child.pid).umask, 0o002);
assert.equal(table.credOf(login.pid).umask, 0o077, 'child umask changes are isolated from the parent');

const laterChild = table.spawn('node', ['later.js'], '/home/user', { parentPid: login.pid });
assert.equal(laterChild.cred.umask, 0o077, 'later children inherit the current parent umask');

assert.throws(() => table.credOf(0), /process|pid/i, 'pid zero is never an implicit kernel credential');
assert.throws(() => table.credOf(999_999), /process|pid/i, 'unknown pids do not default to root');

console.log('process-table credentials: ok');
