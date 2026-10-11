#!/usr/bin/env bun
// The namespace's own permission checks (a lookup leaving a mount point or a
// directory above one, a read of one, a removal from one) judge by the one
// POSIX class calculation, with the namespace's own policy around it: root
// searches every directory, whatever its mode, as Linux's root does; anyone
// else needs the class bits.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const root = sqliteFiles(new SqliteVFS(harness.sql, harness.ctx), CRED_KERNEL);
const mounted = new MemoryVFS({ uid: 1000, gid: 1000 });
mounted.writeFile('/f', new TextEncoder().encode('inside'));
// The mounted root: its owner may read and write it, and no one may search it.
mounted.chmod('/', 0o600);
const ns = new CompositeVFS(root);
ns.mount('/m', mounted);

const as = (uid, gid, groups = [gid]) => ns.as({ uid, gid, groups, umask: 0o022 });
const refused = (error) => error.code === 'EACCES';

assert.equal((await as(0, 0).stat('/m/f'))?.size, 6, 'root searches a mount point whose mode grants no search');
await assert.rejects(async () => as(1000, 1000).stat('/m/f'), refused, 'its owner, without x, does not');
await assert.rejects(async () => as(2000, 1000).stat('/m/f'), refused, 'nor its group');
mounted.chmod('/', 0o710);
assert.equal((await as(2000, 2000, [2000, 1000]).stat('/m/f'))?.size, 6, 'a supplementary group with x searches it');
await assert.rejects(async () => as(3000, 3000).stat('/m/f'), refused, 'other, without x, does not');

console.log('composite-search-permission: ok');
