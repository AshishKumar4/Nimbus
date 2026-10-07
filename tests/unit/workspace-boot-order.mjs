#!/usr/bin/env bun
// A workspace has one filesystem. The kernel keeps processes, ports and the
// network and owns no filesystem; right after create, /proc and /dev are
// the namespace's mounts, and the shell and the process bindings see the
// same tree.

import assert from 'node:assert/strict';
import { testBox } from './lib/test-box.mjs';

const box = await testBox();
assert.equal('vfs' in box.kernel, false, 'the kernel has no filesystem');
assert.equal('proc' in box.kernel, false);

const mounts = await box.commands.run('cat /proc/mounts');
assert.equal(mounts.exitCode, 0, mounts.stderr);
assert.deepEqual(mounts.stdout.trim().split('\n').map((line) => line.split(' ')[1]), ['/', '/proc', '/dev']);

const ls = await box.commands.run('ls /');
assert.match(ls.stdout, /\bdev\b/);
assert.match(ls.stdout, /\bproc\b/);
assert.equal((await box.commands.run('echo hi > /dev/null && cat /dev/null')).exitCode, 0);

// What the shell writes, a bound process reads, and the other way round.
await box.commands.run('echo from-shell > /home/user/x.txt');
const proc = box.files.bind({ pid: 4321, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
assert.equal(new TextDecoder().decode(proc.readFile('/home/user/x.txt')), 'from-shell\n');
proc.writeFile('/home/user/y.txt', 'from-process');
assert.equal((await box.commands.run('cat /home/user/y.txt')).stdout, 'from-process');

// The kernel's resolver still knows localhost.
assert.equal(box.kernel.dns.lookup('localhost')?.value, '127.0.0.1');

box.destroy();
console.log('workspace-boot-order: ok');
