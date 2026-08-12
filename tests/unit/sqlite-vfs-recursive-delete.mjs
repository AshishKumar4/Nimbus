#!/usr/bin/env bun
// Removing a tree resolves the subtree through the children index and commits
// it in bounded groups, instead of scanning every inode once per entry and
// committing one transaction apiece. A 19,429-file tree cost ~190 million
// synchronous comparisons that way — long enough on the object's only thread
// to drop the session's socket.
//
// What must not change: the same entries disappear, the same inodes are freed,
// superseded content is still collected, permissions still govern what may be
// removed, and any failure leaves a state a replay completes correctly.

import assert from 'node:assert/strict';
import {
  MAX_TX_BLOB_BYTES,
  MAX_TX_LOGICAL_ROWS,
  MAX_TX_SQL_EXECS,
} from '../../packages/worker/src/constants.ts';
import { SqliteVFS } from '../../packages/worker/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/worker/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

function openVfs(harness = createSqliteVfsTestHarness()) {
  const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
  return { harness, rawVfs, vfs: rawVfs.as(CRED_KERNEL) };
}

function reopenVfs(harness) {
  return openVfs(createSqliteVfsTestHarness(harness.db)).vfs;
}

/** A tree of `dirs` directories each holding `perDir` files, plus one nested level. */
function seedTree(vfs, root, dirs, perDir) {
  const paths = [];
  vfs.mkdir(root, { recursive: true });
  paths.push(root);
  for (let d = 0; d < dirs; d++) {
    const dir = `${root}/pkg-${d}/lib`;
    vfs.mkdir(dir, { recursive: true });
    paths.push(`${root}/pkg-${d}`, dir);
    for (let f = 0; f < perDir; f++) {
      const path = `${dir}/file-${f}.js`;
      vfs.writeFile(path, `module.exports = ${d * perDir + f};\n`);
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Everything the durable store holds, so two runs can be compared whole.
 * Content ids are freshly minted per write, so they are relabelled by the path
 * that references them — what must match is which content survives, not the
 * random name it was given.
 */
function durableState(harness) {
  const inodes = harness.sql.exec(
    'SELECT path, parent_path, kind, size, mode, uid, gid, chunk_count, content_id FROM inodes ORDER BY path',
  );
  const label = new Map(inodes.map((row) => [row.content_id, `content(${row.path})`]));
  const relabel = (contentId) => label.get(contentId) ?? `unreferenced(${label.size})`;
  return {
    inodes: inodes.map((row) => ({ ...row, content_id: relabel(row.content_id) })),
    lifecycle: harness.sql
      .exec('SELECT content_id, state FROM content_lifecycle')
      .map((row) => ({ ...row, content_id: relabel(row.content_id) }))
      .sort((a, b) => (a.content_id < b.content_id ? -1 : 1)),
    chunks: harness.sql
      .exec('SELECT content_id, chunk_id FROM file_chunks')
      .map((row) => ({ ...row, content_id: relabel(row.content_id) }))
      .sort((a, b) => (a.content_id < b.content_id ? -1 : a.content_id > b.content_id ? 1 : a.chunk_id - b.chunk_id)),
  };
}

function counters(rawVfs) {
  const stats = rawVfs.getStats();
  return { files: stats.files, directories: stats.directories, usedBytes: stats.usedBytes };
}

// ── Subtree resolution is by prefix, not by name ──────────────────────────
// The scan this replaced matched `path === root || path.startsWith(root + '/')`.
// Sibling names that share the root as a string prefix must survive.
{
  const { harness, rawVfs, vfs } = openVfs();
  vfs.mkdir('a/b/c', { recursive: true });
  vfs.mkdir('ab', { recursive: true });
  vfs.mkdir('a-b', { recursive: true });
  vfs.writeFile('a/b/c/deep.txt', 'deep');
  vfs.writeFile('a/keep-me', 'x');
  vfs.writeFile('ab/other.txt', 'sibling');
  vfs.writeFile('a-b/other.txt', 'sibling');
  vfs.writeFile('abc', 'sibling');

  assert.equal(vfs.removeRecursive('a'), 5);

  const reconstructed = reopenVfs(harness);
  for (const gone of ['a', 'a/b', 'a/b/c', 'a/b/c/deep.txt', 'a/keep-me']) {
    assert.equal(reconstructed.exists(gone), false, `${gone} should be removed`);
  }
  for (const kept of ['ab', 'ab/other.txt', 'a-b', 'a-b/other.txt', 'abc']) {
    assert.equal(reconstructed.exists(kept), true, `${kept} shares a prefix and must survive`);
  }
  assert.equal(rawVfs._verifyCounters(), null, 'counters must track the removal');
}

// The same prefix resolution serves a batch that names a directory as a
// delete path — how a write stream's delete record and an interrupted
// install's cleanup remove a tree.
{
  const { harness, rawVfs, vfs } = openVfs();
  seedTree(vfs, 'batch', 3, 4);
  vfs.writeFile('batchfile', 'sibling');
  vfs.writeBatch({ inodes: [], chunks: [], deletePaths: ['batch/pkg-1'] });

  const reconstructed = reopenVfs(harness);
  assert.equal(reconstructed.exists('batch/pkg-1'), false);
  assert.equal(reconstructed.exists('batch/pkg-1/lib/file-0.js'), false);
  assert.equal(reconstructed.exists('batch/pkg-0/lib/file-0.js'), true);
  assert.equal(reconstructed.exists('batchfile'), true);
  assert.equal(rawVfs._verifyCounters(), null);
}

// Resolving what is under a path must cost the subtree, not the filesystem.
// Deleting one entry at a time from a whole-inode scan made removing a tree of
// N entries O(N²); at 19,429 files that was ~190 million comparisons on the
// object's only thread. Counting iterations is the only way to see it — the
// span is synchronous, and `Date.now()` does not advance across it.
{
  const { rawVfs, vfs } = openVfs();
  seedTree(vfs, 'big', 40, 20); // 40 × (2 dirs + 20 files) + root = 881 entries
  seedTree(vfs, 'small', 1, 4); // the tree actually removed: 7 entries

  let walked = 0;
  const inodes = rawVfs.inodes;
  const whole = new Set(['values', 'keys', 'entries', Symbol.iterator]);
  rawVfs.inodes = new Proxy(inodes, {
    get(target, property) {
      if (whole.has(property)) walked++;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    assert.equal(vfs.removeRecursive('small'), 7);
  } finally {
    rawVfs.inodes = inodes;
  }
  assert.equal(walked, 0, 'removing a subtree walked the whole inode table');
  assert.equal(vfs.exists('big/pkg-39/lib/file-19.js'), true);
}

// A path with no inode is still ENOENT, and a plain file removes as itself.
{
  const { vfs } = openVfs();
  assert.throws(() => vfs.removeRecursive('missing'), /ENOENT/);
  vfs.writeFile('solo.txt', 'x');
  assert.equal(vfs.removeRecursive('solo.txt'), 1);
  assert.equal(vfs.exists('solo.txt'), false);
}

// A symlink is removed as the link, never followed into the target's subtree.
{
  const { vfs } = openVfs();
  vfs.mkdir('target/inner', { recursive: true });
  vfs.writeFile('target/inner/kept.txt', 'x');
  vfs.symlink('target', 'link');
  assert.equal(vfs.removeRecursive('link'), 1);
  assert.equal(vfs.exists('target/inner/kept.txt'), true);
  assert.equal(vfs.isSymlink('link'), false);
}

// ── Bounded groups, not one transaction per entry ─────────────────────────
{
  const { harness, rawVfs, vfs } = openVfs();
  const paths = seedTree(vfs, 'tree', 24, 25); // 24 × (2 dirs + 25 files) + root
  const maintenanceBefore = rawVfs.getStats().sql.phases.maintenanceMs.count;
  const before = harness.transactionCount;
  const removed = vfs.removeRecursive('tree');
  const transactions = harness.transactionCount - before;

  assert.equal(removed, paths.length);
  assert.ok(
    transactions <= removed / 8,
    `${transactions} transactions for ${removed} entries: a regression to per-entry commits`,
  );

  const stats = rawVfs.getStats();
  assert.ok(stats.sql.transactions.boundedPeak.blobBytes <= MAX_TX_BLOB_BYTES);
  assert.ok(stats.sql.transactions.boundedPeak.logicalRows <= MAX_TX_LOGICAL_ROWS);
  assert.ok(stats.sql.transactions.boundedPeak.sqlExecs <= MAX_TX_SQL_EXECS);

  // One maintenance pass for the whole removal, not one per group. The orphan
  // scan reads the chunk table, so charging it per transaction put a scan of
  // every chunk in the filesystem inside each of the removal's groups.
  assert.equal(
    stats.sql.phases.maintenanceMs.count - maintenanceBefore,
    1,
    'a removal owes one maintenance pass, however many transactions it took',
  );

  const reconstructed = reopenVfs(harness);
  assert.equal(reconstructed.exists('tree'), false);
  assert.equal(rawVfs._verifyCounters(), null);
  assert.deepEqual(counters(rawVfs), { files: 0, directories: 0, usedBytes: 0 });
}

// ── Group-atomic removal is indistinguishable from per-entry removal ──────
// Same tree, same credential: one VFS removes it in bounded groups, the other
// unlinks and rmdirs every entry by hand. The durable store must match.
{
  const grouped = openVfs();
  const solo = openVfs();
  const layout = (vfs) => {
    seedTree(vfs, 'app/node_modules', 8, 12);
    // Superseded content: a file rewritten before the delete leaves an older
    // generation whose collection must be identical either way.
    vfs.writeFile('app/node_modules/pkg-0/lib/file-0.js', 'v1');
    vfs.writeFile('app/node_modules/pkg-0/lib/file-0.js', 'v2 is longer');
    vfs.chmod('app/node_modules/pkg-1/lib/file-1.js', 0o600);
    vfs.chown('app/node_modules/pkg-2', 1234, 5678);
    // A neighbouring tree that must be untouched by either arm.
    vfs.mkdir('app/src', { recursive: true });
    vfs.writeFile('app/src/index.js', 'kept');
  };
  layout(grouped.vfs);
  layout(solo.vfs);

  const removedByGroup = grouped.vfs.removeRecursive('app/node_modules');

  const removeByHand = (vfs, path) => {
    let count = 0;
    for (const entry of vfs.readdir(path)) {
      const child = `${path}/${entry.name}`;
      count += entry.type === 'directory' ? removeByHand(vfs, child) : (vfs.unlink(child), 1);
    }
    vfs.rmdir(path);
    return count + 1;
  };
  const removedByHand = removeByHand(solo.vfs, 'app/node_modules');

  assert.equal(removedByGroup, removedByHand);
  // Maintenance is bounded per call, so drain both to the same fixpoint before
  // comparing what content survived.
  for (let pass = 0; pass < 40; pass++) {
    grouped.rawVfs.runContentMaintenance(8);
    solo.rawVfs.runContentMaintenance(8);
  }
  assert.deepEqual(durableState(grouped.harness), durableState(solo.harness));
  assert.deepEqual(counters(grouped.rawVfs), counters(solo.rawVfs));
  assert.equal(grouped.rawVfs._verifyCounters(), null);
  assert.equal(
    grouped.harness.sql.exec('SELECT COUNT(*) AS n FROM file_chunks')[0].n,
    1,
    'only the surviving file keeps content',
  );
  assert.equal(reopenVfs(grouped.harness).readFileString('app/src/index.js'), 'kept');
}

// Watchers see the same removals as the per-entry walk produced, deepest
// first — fs.watch consumers are downstream of this.
{
  const record = async (arm, remove) => {
    const events = [];
    arm.rawVfs.events.on((batch) => {
      for (const event of batch) events.push(`${event.type} ${event.path}`);
    });
    remove(arm.vfs);
    await new Promise((resolve) => setTimeout(resolve, 0));
    return events;
  };
  const grouped = openVfs();
  const solo = openVfs();
  for (const arm of [grouped, solo]) seedTree(arm.vfs, 'ev', 3, 3);
  await new Promise((resolve) => setTimeout(resolve, 0)); // drain the seed's events

  const groupedEvents = await record(grouped, (vfs) => vfs.removeRecursive('ev'));
  const soloEvents = await record(solo, (vfs) => {
    const walk = (path) => {
      for (const entry of vfs.readdir(path)) {
        const child = `${path}/${entry.name}`;
        if (entry.type === 'directory') walk(child);
        else vfs.unlink(child);
      }
      vfs.rmdir(path);
    };
    walk('ev');
  });
  assert.ok(groupedEvents.length > 0);
  assert.deepEqual([...groupedEvents].sort(), [...soloEvents].sort());
  const depth = (line) => line.split(' ')[1].split('/').length;
  for (let index = 1; index < groupedEvents.length; index++) {
    assert.ok(
      depth(groupedEvents[index - 1]) >= depth(groupedEvents[index]),
      'entries must be removed deepest first',
    );
  }
}

// ── Permissions still govern what may be removed ──────────────────────────
const CRED_USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

// A directory that cannot be read cannot have its entries removed — the check
// the recursive walk got from readdir, which resolving from the index skips.
{
  const { rawVfs, vfs } = openVfs();
  vfs.mkdir('u/opaque', { recursive: true });
  vfs.writeFile('u/opaque/secret.txt', 'x');
  vfs.chown('u', 1000, 1000);
  vfs.chown('u/opaque', 1000, 1000);
  vfs.chown('u/opaque/secret.txt', 1000, 1000);
  vfs.chmod('u/opaque', 0o333);

  const user = rawVfs.as(CRED_USER);
  assert.throws(() => user.removeRecursive('u'), /EACCES/);
  // Nothing was removed: the refusal precedes the first commit.
  assert.equal(vfs.exists('u/opaque/secret.txt'), true);
  assert.equal(vfs.exists('u/opaque'), true);

  vfs.chmod('u/opaque', 0o755);
  assert.equal(user.removeRecursive('u'), 3);
}

// Removal still needs write+execute on the parent of the root.
{
  const { rawVfs, vfs } = openVfs();
  vfs.mkdir('locked/tree', { recursive: true });
  vfs.writeFile('locked/tree/file.txt', 'x');
  vfs.chmod('locked', 0o555);
  const user = rawVfs.as(CRED_USER);
  assert.throws(() => user.removeRecursive('locked/tree'), /EACCES/);
  assert.equal(vfs.exists('locked/tree/file.txt'), true);
}

// An entry inside a directory the caller cannot write is refused, and the
// group holding it commits nothing — the same refusal a per-entry unlink of
// that path would have raised.
{
  const { rawVfs, vfs } = openVfs();
  vfs.mkdir('shared/mine', { recursive: true });
  vfs.mkdir('shared/theirs', { recursive: true });
  vfs.writeFile('shared/theirs/file.txt', 'x');
  vfs.chown('shared', 1000, 1000);
  vfs.chown('shared/mine', 1000, 1000);
  // `shared/theirs` stays root-owned and read-only to the caller.
  vfs.chmod('shared/theirs', 0o755);

  const user = rawVfs.as(CRED_USER);
  assert.throws(() => user.unlink('shared/theirs/file.txt'), /EACCES/);
  assert.throws(() => user.removeRecursive('shared'), /EACCES/);
  assert.equal(vfs.exists('shared/theirs/file.txt'), true);
  assert.equal(vfs.exists('shared/mine'), true, 'the refused group commits nothing');
}

// ── Faults ────────────────────────────────────────────────────────────────
// Faulting any statement of a group's transaction leaves nothing from that
// group visible, keeps the groups that already committed, and converges on
// replay.
{
  const probe = openVfs();
  seedTree(probe.vfs, 'crash', 4, 30);
  const firstGroup = probe.harness.transactionCount + 1;
  probe.vfs.removeRecursive('crash');
  const groupStatements = probe.harness.statements
    .filter((statement) => statement.transaction === firstGroup).length;
  assert.ok(groupStatements > 1, 'expected the first group to commit many statements at once');

  for (let statement = 1; statement <= groupStatements; statement++) {
    const { harness, rawVfs, vfs } = openVfs();
    const paths = seedTree(vfs, 'crash', 4, 30);
    harness.failOnTransactionStatement(statement, {
      transaction: harness.transactionCount + 1,
      error: new Error(`injected group fault at ${statement}`),
    });
    assert.throws(() => vfs.removeRecursive('crash'), /injected group fault/);
    harness.clearFault();

    // The faulted group is the first one, so nothing at all was removed.
    const afterCrash = reopenVfs(harness);
    for (const path of paths) {
      assert.equal(afterCrash.exists(path), true, `${path} lost to a fault at ${statement}`);
    }

    assert.equal(vfs.removeRecursive('crash'), paths.length);
    assert.equal(reopenVfs(harness).exists('crash'), false);
    assert.equal(rawVfs._verifyCounters(), null);
  }
}

// A fault in a later group keeps the earlier ones, and the replay finishes the
// rest: a committed prefix of a deepest-first removal is always a valid tree.
{
  const { harness, rawVfs, vfs } = openVfs();
  const paths = seedTree(vfs, 'partial', 6, 30);
  // Fault the second group specifically. Transaction numbers cannot address it
  // — each group is followed by content-maintenance transactions of its own —
  // so count the transactions that remove inodes.
  let groups = 0;
  let groupTransaction = null;
  harness.setFaultInjector((statement) => {
    if (!statement.sql.startsWith('DELETE FROM inodes WHERE path')) return null;
    if (statement.transaction !== groupTransaction) {
      groupTransaction = statement.transaction;
      groups++;
    }
    return groups === 2 ? new Error('injected second-group fault') : null;
  });
  assert.throws(() => vfs.removeRecursive('partial'), /injected second-group fault/);
  harness.clearFault();

  const afterCrash = reopenVfs(harness);
  assert.equal(afterCrash.exists('partial'), true, 'the root outlives a partial removal');
  const survivors = paths.filter((path) => afterCrash.exists(path));
  assert.ok(survivors.length > 0 && survivors.length < paths.length);
  for (const survivor of survivors) {
    // Every surviving entry still has its parent: a committed prefix is a tree.
    const cut = survivor.lastIndexOf('/');
    if (cut < 0) continue;
    const parent = survivor.slice(0, cut);
    assert.equal(afterCrash.exists(parent), true, `${survivor} outlived its parent`);
  }
  assert.equal(rawVfs._verifyCounters(), null);

  assert.equal(vfs.removeRecursive('partial'), survivors.length);
  assert.equal(reopenVfs(harness).exists('partial'), false);
}

// ── The window another request can take a lease in ────────────────────────
// A group commits after the entries that follow it were planned. Driving the
// real window: a lease is taken from inside the first group's transaction, so
// it is live by the time the second group flushes.
{
  const { harness, rawVfs, vfs } = openVfs();
  const paths = seedTree(vfs, 'leased', 6, 30);
  const transactionSync = harness.ctx.storage.transactionSync;
  let lease = null;
  harness.ctx.storage.transactionSync = (callback) => {
    const result = transactionSync.call(harness.ctx.storage, callback);
    if (lease === null) lease = rawVfs.acquireExclusiveMutation('leased');
    return result;
  };

  assert.throws(() => vfs.removeRecursive('leased'), /EBUSY/);
  harness.ctx.storage.transactionSync = transactionSync;
  assert.notEqual(lease, null, 'expected a lease to be taken between groups');

  const duringLease = reopenVfs(harness);
  assert.equal(duringLease.exists('leased'), true);
  const survivors = paths.filter((path) => duringLease.exists(path));
  assert.ok(
    survivors.length > 0 && survivors.length < paths.length,
    'exactly the groups before the lease should have committed',
  );

  rawVfs.releaseExclusiveMutation(lease.owner);
  assert.equal(vfs.removeRecursive('leased'), survivors.length);
  assert.equal(reopenVfs(harness).exists('leased'), false);
  assert.equal(rawVfs._verifyCounters(), null);
}

// A lease held over the tree before the removal starts refuses it outright.
{
  const { rawVfs, vfs } = openVfs();
  seedTree(vfs, 'held', 2, 4);
  const lease = rawVfs.acquireExclusiveMutation('held');
  assert.throws(() => vfs.removeRecursive('held'), /EBUSY/);
  assert.equal(vfs.exists('held'), true);
  rawVfs.releaseExclusiveMutation(lease.owner);
  assert.ok(vfs.removeRecursive('held') > 0);
}

console.log('sqlite-vfs-recursive-delete: ok');
