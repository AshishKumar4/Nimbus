#!/usr/bin/env bun
/**
 * fs-list-tree — everything beneath a directory in one answer (the session's
 * fsListTree, core runtime/fs-list-tree.ts): the subtree whole, in path order,
 * at one revision, as the process's credential lists it; a subtree past the
 * bound is refused (E2BIG), never cut short.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { subtreeListing } from '../../packages/core/src/runtime/fs-list-tree.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const kernel = engine.as(CRED_KERNEL);
for (const dir of ['home/user/proj/a/b', 'home/user/proj2', 'home/user/proj/closed']) kernel.mkdir(dir, { recursive: true });
kernel.chown('home/user', 1000, 1000);
for (const file of ['home/user/proj/x.txt', 'home/user/proj/a/y.txt', 'home/user/proj/a/b/z.txt', 'home/user/proj2/other.txt', 'home/user/proj/closed/secret.txt']) {
  kernel.writeFile(file, file);
}
kernel.chmod('home/user/proj/closed', 0o700);
const bridge = new ProcessFiles(engine).bind({ pid: 7, cred: USER });

const listing = await subtreeListing(bridge, '/home/user/proj', 100);
assert.equal(listing.rev, engine.revision());
assert.deepEqual(listing.entries.map((entry) => entry.path.replace(/^\/+/, '')), [
  'home/user/proj/a',
  'home/user/proj/a/b',
  'home/user/proj/a/b/z.txt',
  'home/user/proj/a/y.txt',
  'home/user/proj/closed',
  'home/user/proj/x.txt',
], 'the subtree whole, in path order: not the root, not a sibling sharing its prefix, not what the credential cannot search');
assert.ok(listing.entries.every((entry) => entry.stat && typeof entry.rev === 'number'));
assert.deepEqual((await subtreeListing(bridge, 'home/user/proj/a/b', 1)).entries.map((entry) => entry.path.replace(/^\/+/, '')), ['home/user/proj/a/b/z.txt'], 'exactly the bound');
await assert.rejects(subtreeListing(bridge, '/home/user/proj', 5), (error) => error.code === 'E2BIG', 'past the bound it is refused, not cut short');
assert.deepEqual((await subtreeListing(bridge, '/home/user/proj/a/b/z.txt', 10)).entries, [], 'a file has nothing beneath it');
console.log('fs-list-tree: ok');
