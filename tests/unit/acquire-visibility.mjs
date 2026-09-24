#!/usr/bin/env bun
// An ACQUIRE delta names only what the caller could list, and never loses a
// name it could.
//
// A delta tells a resident store which of its rows changed. It named every
// logged path that had a name for the caller, including the files in another
// principal's private root and in any directory the caller cannot traverse,
// so a delta was a way to learn names that list() refuses. The rule is now
// list()'s own: a path is named only if every directory above it is
// traversable. A delta is also about paths that are gone, and their
// directories may be gone too, so a directory removed since the path changed
// is judged by the mode it had when it went: removing, renaming or remaking a
// private directory does not reveal what was in it. What the caller could
// list is still named, deleted or not, so no row it filled goes stale.

import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';

import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { _rpcFsAcquire, _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { FACET_RESIDENT_STORE_SOURCE } from '../../packages/worker/src/vfs/facet-resident-store.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './session-supervisor-ops.mjs';

const A = Object.freeze({ uid: 5001, gid: 5001, groups: Object.freeze([5001]), umask: 0o022 });
const B = Object.freeze({ uid: 5002, gid: 5002, groups: Object.freeze([5002]), umask: 0o022 });
const PLAIN = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const dec = new TextDecoder();

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const root = raw.as(CRED_KERNEL);
root.mkdir('tmp', { mode: 0o1777 });
root.chmod('tmp', 0o1777);
for (const [who, key] of [[A, 'var/agents/a/tmp'], [B, 'var/agents/b/tmp']]) {
  root.mkdir(key, { recursive: true, mode: 0o755 });
  root.chmod(key, 0o700);
  root.chown(key, who.uid, who.gid);
  raw.confinePrincipal(who.uid, key);
}
root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', PLAIN.uid, PLAIN.gid);
root.mkdir('home/b', { mode: 0o755 });
root.chown('home/b', B.uid, B.gid);

const a = raw.as(A);
const b = raw.as(B);
const plain = raw.as(PLAIN);

/** Every name A's and PLAIN's deltas carry for the mutations `run` makes. */
function named(run) {
  const cursor = raw.revision();
  run();
  const names = {};
  for (const [who, view] of [['a', a], ['plain', plain]]) {
    const delta = view.invalidatedSince(raw.epoch, cursor);
    assert.equal(delta.poison, false, `${who}'s delta was poisoned`);
    names[who] = delta.paths.map((entry) => entry.path).sort();
  }
  return names;
}
/** Nothing inside `dir` was named: its own name is listable, what it holds is not. */
const hidden = (names, dir) => {
  for (const [who, paths] of Object.entries(names)) {
    const leaked = paths.filter((path) => path.startsWith(`${dir}/`));
    assert.deepEqual(leaked, [], `${who} learned names inside ${dir}`);
  }
};
const asText = (cell) => (typeof cell === 'string' ? cell : dec.decode(cell));

// ── Another principal's private /tmp ──────────────────────────────────────
{
  const names = named(() => {
    b.writeFile('/tmp/b-secret', 'b');
    b.mkdir('/tmp/b-dir');
    b.writeFile('/tmp/b-dir/deeper', 'b');
  });
  hidden(names, 'var/agents/b/tmp');
  // B's /tmp/b-secret is not A's /tmp/b-secret either.
  assert.ok(!names.a.some((path) => path.startsWith('tmp/')), 'B\'s file was named in A\'s /tmp');
}

// ── A private directory elsewhere, while it stands and after it goes ──────
b.mkdir('/home/b/private');
b.chmod('/home/b/private', 0o700);
{
  const names = named(() => b.writeFile('/home/b/private/x', 'x'));
  hidden(names, 'home/b/private');
}
{
  // Removed: its children's names were never listable, so they stay hidden.
  // The directory's own name was listable, in home/b, and is reported.
  const names = named(() => b.removeRecursive('/home/b/private'));
  hidden(names, 'home/b/private');
  assert.ok(names.a.includes('home/b/private'), 'the removed directory itself is listable');
}
{
  // Renamed away: the old names are judged by the directory they were in.
  b.mkdir('/home/b/private2');
  b.chmod('/home/b/private2', 0o700);
  b.writeFile('/home/b/private2/y', 'y');
  const names = named(() => b.rename('/home/b/private2', '/home/b/moved'));
  hidden(names, 'home/b/private2');
  hidden(names, 'home/b/moved');
  assert.ok(names.a.includes('home/b/moved') && names.a.includes('home/b/private2'), 'both names are listable');
}
{
  // Removed and made again, readable this time: what was in the private one
  // still is not the caller's to know.
  b.mkdir('/home/b/again');
  b.chmod('/home/b/again', 0o700);
  b.writeFile('/home/b/again/z', 'z');
  const cursor = raw.revision();
  b.removeRecursive('/home/b/again');
  b.mkdir('/home/b/again');
  b.chmod('/home/b/again', 0o755);
  b.writeFile('/home/b/again/open', 'o');
  const names = a.invalidatedSince(raw.epoch, cursor).paths.map((entry) => entry.path);
  assert.ok(!names.includes('home/b/again/z'), 'the old private file was named');
  assert.ok(names.includes('home/b/again/open'), 'the new readable file was not');
}
{
  // Made private before the write: judged by the mode it has.
  b.mkdir('/home/b/closing');
  const names = named(() => {
    b.chmod('/home/b/closing', 0o700);
    b.writeFile('/home/b/closing/w', 'w');
  });
  hidden(names, 'home/b/closing');
}

// ── What the caller could list is always named ────────────────────────────
{
  plain.mkdir('/home/user/proj/src', { recursive: true });
  plain.writeFile('/home/user/proj/src/a.js', 'a');
  plain.writeFile('/home/user/proj/top.js', 't');
  const names = named(() => plain.removeRecursive('/home/user/proj'));
  for (const path of ['home/user/proj', 'home/user/proj/src', 'home/user/proj/src/a.js', 'home/user/proj/top.js']) {
    assert.ok(names.a.includes(path), `A was not told ${path} is gone`);
    assert.ok(names.plain.includes(path), `PLAIN was not told ${path} is gone`);
  }
}
{
  plain.mkdir('/home/user/pub');
  plain.writeFile('/home/user/pub/b.txt', 'b');
  const names = named(() => plain.rename('/home/user/pub', '/home/user/pub2'));
  for (const path of ['home/user/pub/b.txt', 'home/user/pub2/b.txt']) assert.ok(names.a.includes(path), path);
}
{
  // A's own private /tmp, under its own names.
  const names = named(() => a.writeFile('/tmp/mine', 'm'));
  assert.ok(names.a.includes('tmp/mine'));
  hidden({ plain: names.plain }, 'var/agents/a/tmp');
}

// ── A resident store's row for a removed file is evicted ──────────────────
// The store evicts exactly the paths a delta names. A delta that dropped a
// path because its directory was gone would leave the row, and the process
// would go on reading a file `rm -rf` had removed.
{
  const sqlShim = () => {
    const db = new Database(':memory:');
    return {
      exec(query, ...params) {
        if (/^\s*(CREATE|INSERT|UPDATE|DELETE|REPLACE)/i.test(query)) {
          db.query(query).run(...params);
          return [];
        }
        return db.query(query).all(...params);
      },
      get databaseSize() { return 0; },
    };
  };
  const store = new Function(
    FACET_RESIDENT_STORE_SOURCE
      + '\nreturn { __residentBind, __residentAdoptModuleBundle, __residentSynchronizeFromSupervisor,'
      + ' __residentAdmit, __residentCursor, __residentGet };',
  )();
  store.__residentBind({ storage: { sql: sqlShim() } });
  const processes = new SessionProcessSupervisor();
  const host = attachSupervisorOps({ sqliteFs: raw, processes, ensureSqliteFs() {} });
  const { pid } = processes.spawn('node', ['node'], '/', { cred: A });
  const supervisor = {
    fsList: (after, limit) => _rpcFsList(host, after ?? null, limit ?? null, pid),
    fsReadBatch: (requests) => _rpcFsReadBatch(host, requests, pid),
    fsAcquire: (epoch, cursor) => _rpcFsAcquire(host, epoch, cursor, pid),
  };
  plain.mkdir('/home/user/work/lib', { recursive: true });
  plain.writeFile('/home/user/work/lib/index.js', 'export default 1;');
  plain.mkdir('/home/user/shelf');
  plain.writeFile('/home/user/shelf/book.txt', 'book');
  store.__residentAdoptModuleBundle({}, { epoch: raw.epoch, rev: raw.revision() });
  const filled = await store.__residentSynchronizeFromSupervisor(supervisor);
  assert.equal(filled.failed, 0);
  for (const path of ['home/user/work/lib/index.js', 'home/user/shelf/book.txt']) {
    assert.ok(store.__residentGet(path) !== undefined, `the store did not fill ${path}`);
  }
  plain.removeRecursive('/home/user/work');
  plain.rename('/home/user/shelf', '/home/user/cupboard');
  const held = store.__residentCursor();
  const applied = store.__residentAdmit(await supervisor.fsAcquire(held.epoch, held.rev));
  assert.deepEqual(
    [...applied.dropped].sort(),
    ['home/user/shelf/book.txt', 'home/user/work/lib/index.js'],
    'a row for a file that is gone was kept',
  );
  assert.equal(store.__residentGet('home/user/work/lib/index.js'), undefined);
  assert.equal(store.__residentGet('home/user/shelf/book.txt'), undefined);
  const refilled = await store.__residentSynchronizeFromSupervisor(supervisor);
  assert.equal(refilled.failed, 0);
  assert.equal(asText(store.__residentGet('home/user/cupboard/book.txt')), 'book');
}

console.log('acquire-visibility: ok');
