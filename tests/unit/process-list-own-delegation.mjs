#!/usr/bin/env bun
/**
 * process-list-own-delegation — a process lists, through the session's
 * namespace (a mount beyond SQLite makes its listing the namespace's), a
 * subtree it holds: every name there, and no recall of its own delegation.
 * Another process's listing of that subtree waits for the holder (EAGAIN to a
 * caller that cannot wait), never reports its names as absent.
 *
 * Red before (live, wasi-fs-load's second python run): the namespace's views
 * of SQLite carried no delegations, so each directory under the process's
 * own grant met it as another's: the listing caught the recall as an
 * unreachable directory and left its names out, and the process's store took
 * the directory as listed and empty (os.listdir 0, os.path.exists False).
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const kernel = engine.as(CRED_KERNEL);
kernel.mkdir('home/user/d', { recursive: true });
kernel.chown('home/user', USER.uid, USER.gid);
kernel.chown('home/user/d', USER.uid, USER.gid);
for (const name of ['a.txt', 'b.txt', 'c.txt']) {
  kernel.writeFile(`home/user/d/${name}`, name);
  kernel.chown(`home/user/d/${name}`, USER.uid, USER.gid);
}
const files = new ProcessFiles(engine);
// A mount beyond SQLite: a process's listing is the namespace's feed.
files.vfs.mount('/shared', new MemoryVFS());
const holder = files.bind({ pid: 7, cred: USER });
const grant = await holder.acquireExclusiveMutation('/home/user/d', { delegate: { reads: true, inos: 16, bytes: 0 } });

/** Every page of `bridge`'s listing, the paths under home/user/d. */
async function listed(bridge) {
  const out = [];
  let after = null;
  for (;;) {
    const page = await bridge.list(after, 1000);
    for (const entry of page.entries) if (entry.path.startsWith('home/user/d/')) out.push(entry.path);
    if (page.next === null) return out;
    after = page.next;
  }
}

assert.deepEqual(await listed(holder), ['home/user/d/a.txt', 'home/user/d/b.txt', 'home/user/d/c.txt'], 'the holder\'s own subtree was listed without its names');
const recall = await Promise.race([
  Promise.resolve(holder.awaitRecall(grant.owner, 20)),
  new Promise((resolve) => setTimeout(() => resolve(null), 100)),
]);
assert.equal(recall ?? null, null, `listing its own subtree recalled the process's own delegation: ${JSON.stringify(recall)}`);

const other = files.bind({ pid: 8, cred: USER });
await assert.rejects(async () => listed(other), (error) => error.code === 'EAGAIN', 'another process\'s listing took the held names as absent');

// P4b recheck 3: through a mount whose backend is itself a namespace over the same engine
// (an alias), the process's lookups still carry its holds. Red before: the
// nested namespace's as() took the credential and the actor only, and its
// view recalled the process's own delegation.
{
  const alias = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL));
  files.vfs.mount('/alias', alias);
  const recalled = [];
  const watching = (async () => { const kind = await holder.awaitRecall(grant.owner, 200); if (kind) recalled.push(kind); })();
  const seen = await holder.stat('/alias/home/user/d/a.txt');
  assert.notEqual(seen, null);
  assert.equal((await holder.readdir('/alias/home/user/d')).length, 3);
  await watching;
  assert.deepEqual(recalled, [], 'a lookup through the alias namespace recalled the process\'s own delegation');
}

console.log('process-list-own-delegation: ok');
process.exit(0);
