#!/usr/bin/env bun
// What a lookup through the session's namespace costs on its SQLite root
// (Kinu's ask 28): a path of depth d is walked once, d inode lookups, not
// d(d+1)/2 (each component's stat walking its prefix again); and a name that
// is not there is an answer, not an error made and caught on the way.
//
// Red before: a stat at depth 7 cost 35 lookups (and a write's walk as many
// again), and every miss threw an engine error, converted to a VfsError with
// a message and a stack, and mapped back to absent.

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const enc = new TextEncoder();
const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const DIR = '/home/user/a/b/c/d';
const DEPTH = DIR.split('/').length - 1 + 1;

const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const kernel = engine.as(CRED_KERNEL);
kernel.mkdir(DIR.slice(1), { recursive: true });
for (const dir of ['home/user', 'home/user/a', 'home/user/a/b', 'home/user/a/b/c', 'home/user/a/b/c/d']) kernel.chown(dir, 1000, 1000);
kernel.writeFile(`${DIR.slice(1)}/file`, 'there');

// The engine's inode lookups, counted.
const table = engine.inodes;
const get = table.get.bind(table);
let lookups = 0;
table.get = (key) => { lookups++; return get(key); };

const namespace = new CompositeVFS(sqliteFiles(engine, CRED_KERNEL)).as(user);
/** The lookups `run` makes, and its answer. */
const counted = async (run) => {
  lookups = 0;
  const answer = await run();
  return { lookups, answer };
};

// A path of depth d: d lookups, whatever was looked up before it.
{
  for (const warm of [false, true]) {
    if (warm) await namespace.stat('/home/user/a');
    const { lookups: made, answer } = await counted(() => namespace.stat(`${DIR}/file`));
    assert.equal(answer?.type, 'file');
    assert.ok(made <= DEPTH, `a stat at depth ${DEPTH} made ${made} lookups (warm: ${warm})`);
  }
  console.log(`  a stat at depth ${DEPTH} makes at most ${DEPTH} lookups`);
}

// A name that is not there: answered null, with no error thrown to say so.
{
  const view = engine.as(user);
  const statIfPresent = view.statIfPresent;
  let thrown = 0;
  const files = sqliteFiles(engine, user);
  // The backend's view (SqliteFiles), its answers for absence watched.
  const ask = files.view.statIfPresent;
  files.view.statIfPresent = (...args) => {
    try { return ask(...args); } catch (error) { thrown++; throw error; }
  };
  const lone = new CompositeVFS(files);
  const { lookups: made, answer } = await counted(() => lone.stat(`${DIR}/missing`));
  assert.equal(answer, null, 'a missing name answers null');
  assert.equal(thrown, 0, 'and no error was made to say so');
  assert.ok(made <= DEPTH, `and it made ${made} lookups`);
  assert.equal(view.statIfPresent(`${DIR.slice(1)}/missing/deeper`), null, 'nor under a missing directory');
  assert.equal(typeof statIfPresent, 'function');
  console.log('  a missing name is an answer, not an error');
}

// A write of a new file: its walk and its write, each one walk.
{
  const writes = [];
  const stop = namespace.observeWrites((event) => { writes.push(event.type); });
  const { lookups: made } = await counted(() => namespace.writeFile(`${DIR}/new.txt`, enc.encode('new')));
  stop();
  assert.deepEqual(writes, ['create']);
  assert.ok(made <= 3 * DEPTH, `a new file's write at depth ${DEPTH} made ${made} lookups`);
  console.log(`  a new file's write at depth ${DEPTH} makes ${made} lookups`);
}

console.log('namespace-one-walk: ok');
