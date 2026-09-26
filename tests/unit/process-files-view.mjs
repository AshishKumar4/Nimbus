#!/usr/bin/env bun
// ProcessFiles.view(): what a command sees. A `VFS` over the process's own
// bound bridge, never the bare namespace: a mutation under another owner's
// lease is EBUSY, absence is a null stat, every failure is a VfsError with
// the syscall's code, and a mount answers through the same view.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { isVfsError } from '../../packages/core/src/vfs/vfs-error.ts';
import { exists, isDirectory, readText, statOrThrow } from '../../packages/core/src/vfs/vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const enc = new TextEncoder();
const code = async (run) => { try { await run(); return 'ok'; } catch (error) { assert.ok(isVfsError(error), String(error)); return error.code; } };
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
engine.as(CRED_KERNEL).mkdir('home/user', { recursive: true });
engine.as(CRED_KERNEL).chown('home/user', 1000, 1000);
const files = new ProcessFiles(engine);
const vfs = files.view({ pid: 10, cred: USER });

// Absence and errors.
assert.equal(await vfs.stat('/home/user/none'), null);
assert.equal(await exists(vfs, '/home/user/none'), false);
assert.equal(await code(() => statOrThrow(vfs, '/home/user/none')), 'ENOENT');
assert.equal(await code(() => vfs.readFile('/home/user/none')), 'ENOENT');
assert.equal(await code(() => vfs.writeFile('/x', enc.encode('x'))), 'EACCES', '/ is root 0755');

// Writes, appends, directories, the rm -r report.
await vfs.mkdir('/home/user/d/e', { recursive: true });
assert.ok(await isDirectory(vfs, '/home/user/d/e'));
await vfs.writeFile('/home/user/d/log', enc.encode('a'));
await Promise.all([vfs.appendFile('/home/user/d/log', enc.encode('b')), vfs.appendFile('/home/user/d/log', enc.encode('c'))]);
assert.equal((await readText(vfs, '/home/user/d/log')).length, 3, 'concurrent appends both land');
assert.equal(await code(() => vfs.access('/', 2)), 'EACCES');
assert.equal(await vfs.realpath('/home/user/d/../d/e'), '/home/user/d/e');
assert.deepEqual(await vfs.removeRecursive('/home/user/d'), { removed: ['/home/user/d'], kept: [], failures: [] });
assert.equal(await exists(vfs, '/home/user/d'), false);

// writeFile's mode applies at creation only, and atomically (open(O_CREAT, mode)).
await vfs.writeFile('/home/user/kept', enc.encode('a'));
await vfs.chmod('/home/user/kept', 0o644);
await vfs.writeFile('/home/user/kept', enc.encode('b'), { mode: 0o600 });
assert.equal(((await vfs.stat('/home/user/kept')).mode & 0o777).toString(8), '644', 'an existing file keeps its mode');
assert.equal(await readText(vfs, '/home/user/kept'), 'b');
const seen = [];
const watching = files.bind({ pid: 12, cred: USER });
const stop = watching.subscribe('/home/user/fresh', () => seen.push(watching.stat('/home/user/fresh')?.mode & 0o777));
await vfs.writeFile('/home/user/fresh', 'new text', { mode: 0o600 });
stop();
assert.equal(((await vfs.stat('/home/user/fresh')).mode & 0o777).toString(8), '600', 'a new file is created with the mode (minus umask)');
assert.ok(seen.every((mode) => mode === undefined || mode === 0o600), `never visible at another mode: ${seen.map((m) => m?.toString(8))}`);
await vfs.writeFile('/home/user/masked', 'x', { mode: 0o666 });
assert.equal(((await vfs.stat('/home/user/masked')).mode & 0o777).toString(8), '644', 'the umask applies');

// touch, chown -1, text appends, an uncached read.
await vfs.touch('/home/user/t');
assert.equal((await vfs.stat('/home/user/t')).size, 0);
await vfs.appendFile('/home/user/t', 'text');
assert.equal(new TextDecoder().decode(await vfs.readFileUncached('/home/user/t')), 'text');
await vfs.chown('/home/user/t', null, 1000);
assert.equal((await vfs.stat('/home/user/t')).uid, 1000, 'chown with a null uid keeps the owner');
assert.equal(await code(() => vfs.chown('/home/user/none', null, 1000)), 'ENOENT');

// Another owner's lease: the view goes through the process's bridge, so EBUSY.
await vfs.mkdir('/home/user/clone');
await vfs.writeFile('/home/user/clone/f', enc.encode('x'));
const cloner = files.bind({ pid: 11, cred: USER });
const lease = cloner.acquireExclusiveMutation('/home/user/clone');
const refused = await vfs.removeRecursive('/home/user/clone');
assert.deepEqual([refused.removed, refused.kept, refused.failures.map((f) => f.error.code)], [[], ['/home/user/clone'], ['EBUSY']], 'rm -r of a leased clone destination');
assert.equal(await code(() => vfs.writeFile('/home/user/clone/g', enc.encode('x'))), 'EBUSY');
assert.equal(await readText(vfs, '/home/user/clone/f'), 'x', 'nothing was removed');
cloner.releaseExclusiveMutation(lease.owner);
assert.deepEqual((await vfs.removeRecursive('/home/user/clone')).removed, ['/home/user/clone']);

// A mount answers through the same view.
const scratch = new MemoryVFS({ uid: 1000, gid: 1000 });
files.vfs.mount('/mnt/s', scratch);
await vfs.writeFile('/mnt/s/f', enc.encode('m'));
assert.equal(new TextDecoder().decode(scratch.readFile('/f')), 'm');
assert.deepEqual((await vfs.readdir('/mnt/s')).map((e) => e.name), ['f']);

console.log('process-files-view: ok');
