#!/usr/bin/env bun
// ProcessFiles binds processes to ONE namespace: SQLite at `/`, /proc,
// /dev, and whatever the embedder mounts on the workspace's CompositeVFS.
// A process's bridge (what node facets and WASI runtimes use over RPC) and
// a shell command see the same tree, and a path the composite routes to a
// mount goes to that mount, never to a same-named SQLite row under it.

import assert from 'node:assert/strict';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const dec = new TextDecoder();
const harness = createSqliteVfsTestHarness();
const ws = await NimbusWorkspace.create({ sql: harness.sql, transactions: harness.ctx });
const files = ws.filesystem;

// A SQLite row the mount will cover: it must never be what a process reads.
ws.vfs.as(CRED_KERNEL).mkdir('mnt/data', { recursive: true });
ws.vfs.as(CRED_KERNEL).writeFile('mnt/data/shadowed.txt', 'sqlite');
const data = new MemoryVFS({ uid: 1000, gid: 1000 });
data.writeFile('/hello.txt', new TextEncoder().encode('from the mount'));
files.vfs.mount('/mnt/data', data);

const proc = files.bind({ pid: 4242, cred: USER });
assert.deepEqual(proc.readdir('/mnt/data').map((e) => e.name), ['hello.txt'], 'the mount, not the SQLite rows it covers');
assert.equal(dec.decode(proc.readFile('/mnt/data/hello.txt')), 'from the mount');
assert.equal(proc.stat('/mnt/data/shadowed.txt'), null);
proc.writeFile('/mnt/data/written.txt', 'by the process');
assert.equal(dec.decode(data.readFile('/written.txt')), 'by the process', 'a write lands in the mounted backend');
assert.ok(proc.readdir('/').some((e) => e.name === 'proc') && proc.readdir('/').some((e) => e.name === 'dev'));
assert.match(dec.decode(proc.readFile('/proc/mounts')), /^nimbus \/ nimbus-sqlite rw 0 0\nproc \/proc proc ro 0 0\ndevtmpfs \/dev devtmpfs rw 0 0\nmemory \/mnt\/data/);
assert.equal(proc.stat('/dev/null').type, 'file');
// A descriptor on a mounted file reads and writes through the backend.
const fd = proc.open('/mnt/data/hello.txt', { read: true, write: true });
assert.equal(dec.decode(proc.read(fd.id, 0, 4)), 'from');
proc.write(fd.id, 0, new TextEncoder().encode('FROM'));
proc.close(fd.id);
assert.equal(dec.decode(data.readFile('/hello.txt')), 'FROM the mount');

// The shell sees the same namespace.
const listed = await ws.exec('ls /mnt/data && cat /mnt/data/written.txt && cat /proc/mounts');
assert.equal(listed.exitCode, 0, listed.stderr);
assert.match(listed.stdout, /^hello\.txt\s+written\.txt\nby the process/);
assert.match(listed.stdout, /memory \/mnt\/data/);

// A released process is gone for good.
await files.releaseProcess(4242);
assert.throws(() => files.bind({ pid: 4242, cred: USER }), { code: 'ESTALE' });

await ws.close();
console.log('process-files-namespace: ok');
