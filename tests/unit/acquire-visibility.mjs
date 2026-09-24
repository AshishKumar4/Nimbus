#!/usr/bin/env bun
// An ACQUIRE delta names only what its caller may see, and still tells it of
// every change to what it holds.
//
// A delta tells a resident store which of its rows changed, and the store
// evicts exactly what the delta covers. Two rules make that both private and
// coherent:
//
//  - A path the caller has a name for but may not see (a directory above it
//    it cannot enter, or one whose place went after the change) is never
//    dropped: it is reported as the nearest directory above it that the
//    caller may see, `subtree`-scoped. Entries are merged, so a hidden
//    `rm -rf` costs one entry and reveals no name inside it.
//  - A directory that was removed, renamed away, or given another mode,
//    owner or group is reported `structural`.
//
// A reader evicts every row at or under a subtree-scoped or structural entry.
// Dropping hidden entries instead lost changes: a directory made private and
// then removed hid its files' removal, so a store that had filled them kept
// serving them. And a directory made private must stop its store serving
// what it holds.

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
const asText = (cell) => (typeof cell === 'string' ? cell : dec.decode(cell));

/** A's and PLAIN's deltas for the mutations `run` makes. */
function deltas(run) {
  const cursor = raw.revision();
  run();
  const out = {};
  for (const [who, view] of [['a', a], ['plain', plain]]) {
    const delta = view.invalidatedSince(raw.epoch, cursor);
    assert.equal(delta.poison, false, `${who}'s delta was poisoned`);
    out[who] = delta.paths;
  }
  return out;
}
/** No name inside `dir` reached anyone. */
const hidden = (all, dir) => {
  for (const [who, paths] of Object.entries(all)) {
    const leaked = paths.map((entry) => entry.path).filter((path) => path.startsWith(`${dir}/`));
    assert.deepEqual(leaked, [], `${who} learned names inside ${dir}`);
  }
};
const at = (paths, path) => paths.filter((entry) => entry.path === path);

// A resident store for A, over the real RPC handlers.
const store = new Function(
  FACET_RESIDENT_STORE_SOURCE
    + '\nreturn { __residentBind, __residentAdoptModuleBundle, __residentSynchronizeFromSupervisor,'
    + ' __residentAdmit, __residentCursor, __residentGet };',
)();
store.__residentBind({
  storage: {
    sql: (() => {
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
    })(),
  },
});
const processes = new SessionProcessSupervisor();
const host = attachSupervisorOps({ sqliteFs: raw, processes, ensureSqliteFs() {} });
const { pid } = processes.spawn('node', ['node'], '/', { cred: A });
const supervisor = {
  fsList: (after, limit) => _rpcFsList(host, after ?? null, limit ?? null, pid),
  fsReadBatch: (requests) => _rpcFsReadBatch(host, requests, pid),
  fsAcquire: (epoch, cursor) => _rpcFsAcquire(host, epoch, cursor, pid),
};
async function barrier() {
  const held = store.__residentCursor();
  return store.__residentAdmit(await supervisor.fsAcquire(held.epoch, held.rev));
}

plain.mkdir('/home/user/d');
plain.writeFile('/home/user/d/p', 'p v1');
plain.mkdir('/home/user/e');
plain.writeFile('/home/user/e/q', 'q v1');
plain.mkdir('/home/user/work/lib', { recursive: true });
plain.writeFile('/home/user/work/lib/index.js', 'export default 1;');
plain.mkdir('/home/user/shelf');
plain.writeFile('/home/user/shelf/book.txt', 'book');
store.__residentAdoptModuleBundle({}, { epoch: raw.epoch, rev: raw.revision() });
{
  const filled = await store.__residentSynchronizeFromSupervisor(supervisor);
  assert.equal(filled.failed, 0);
  for (const path of ['home/user/d/p', 'home/user/e/q', 'home/user/work/lib/index.js', 'home/user/shelf/book.txt']) {
    assert.ok(store.__residentGet(path) !== undefined, `the store did not fill ${path}`);
  }
}

// ── A directory made private, then removed: its rows are evicted ─────────
{
  const cursor = raw.revision();
  plain.chmod('/home/user/d', 0o700);
  plain.removeRecursive('/home/user/d');
  const paths = a.invalidatedSince(raw.epoch, cursor).paths;
  assert.deepEqual(at(paths, 'home/user/d'), [{ path: 'home/user/d', rev: raw.revision(), subtree: true, structural: true }]);
  hidden({ a: paths }, 'home/user/d');
  const applied = await barrier();
  assert.deepEqual(applied.dropped, ['home/user/d/p'], 'a row for a removed file was kept');
  assert.equal(store.__residentGet('home/user/d/p'), undefined);
}

// ── A directory made private: its rows stop being served ─────────────────
{
  plain.chmod('/home/user/e', 0o700);
  const applied = await barrier();
  assert.deepEqual(applied.dropped, ['home/user/e/q'], 'a row under a directory A was locked out of was kept');
  assert.equal(store.__residentGet('home/user/e/q'), undefined);
  const [read] = await supervisor.fsReadBatch([{ path: 'home/user/e/q', offset: 0, length: 64 }]);
  assert.equal(read.error?.code, 'EACCES', 'A read a file under a directory it may no longer enter');
}

// ── A private directory removed: one entry, and no name inside it ─────────
{
  b.mkdir('/home/b/private');
  b.chmod('/home/b/private', 0o700);
  b.mkdir('/home/b/private/sub');
  for (const name of ['x', 'y', 'sub/z']) b.writeFile(`/home/b/private/${name}`, name);
  const all = deltas(() => b.removeRecursive('/home/b/private'));
  hidden(all, 'home/b/private');
  for (const [who, paths] of Object.entries(all)) {
    assert.deepEqual(
      paths.filter((entry) => entry.path === 'home/b/private' || entry.path.startsWith('home/b/private/')),
      [{ path: 'home/b/private', rev: raw.revision(), subtree: true, structural: true }],
      `${who} did not get exactly one entry for the removed private directory`,
    );
  }
}

// ── Another principal's private /tmp ──────────────────────────────────────
{
  const all = deltas(() => {
    b.writeFile('/tmp/b-secret', 'b');
    b.mkdir('/tmp/b-dir');
    b.writeFile('/tmp/b-dir/deeper', 'b');
  });
  hidden(all, 'var/agents/b/tmp');
  assert.ok(!all.a.some((entry) => entry.path.startsWith('tmp/')), 'B\'s file was named in A\'s /tmp');
  assert.deepEqual(at(all.a, 'var/agents/b/tmp').map((entry) => entry.subtree), [true]);
}

// ── Renamed away, and remade readable: no name from the private one ───────
{
  b.mkdir('/home/b/private2');
  b.chmod('/home/b/private2', 0o700);
  b.writeFile('/home/b/private2/y', 'y');
  const all = deltas(() => b.rename('/home/b/private2', '/home/b/moved'));
  hidden(all, 'home/b/private2');
  hidden(all, 'home/b/moved');
  assert.ok(at(all.a, 'home/b/private2')[0]?.structural, 'the directory renamed away is structural');
}
{
  b.mkdir('/home/b/again');
  b.chmod('/home/b/again', 0o700);
  b.writeFile('/home/b/again/z', 'z');
  const cursor = raw.revision();
  b.removeRecursive('/home/b/again');
  b.mkdir('/home/b/again');
  b.writeFile('/home/b/again/open', 'o');
  const names = a.invalidatedSince(raw.epoch, cursor).paths.map((entry) => entry.path);
  assert.ok(!names.includes('home/b/again/z'), 'a file of the removed private directory was named');
  assert.ok(names.includes('home/b/again/open'), 'a file A may see was not');
}
{
  // Made private before the write: the write is reported at the directory.
  b.mkdir('/home/b/closing');
  const all = deltas(() => {
    b.chmod('/home/b/closing', 0o700);
    b.writeFile('/home/b/closing/w', 'w');
  });
  hidden(all, 'home/b/closing');
  assert.deepEqual(at(all.a, 'home/b/closing').map(({ subtree, structural }) => [subtree, structural]), [[true, true]]);
}

// ── What A may see is named, and a readable rm -rf is evicted whole ───────
{
  const all = deltas(() => {
    plain.writeFile('/home/user/shelf/book.txt', 'book v2');
    plain.writeFile('/home/user/fresh.txt', 'f');
  });
  for (const path of ['home/user/shelf/book.txt', 'home/user/fresh.txt']) {
    assert.deepEqual(at(all.a, path).map(({ subtree, structural }) => [subtree, structural]), [[undefined, undefined]], path);
  }
  const applied = await barrier();
  assert.deepEqual(applied.dropped, ['home/user/shelf/book.txt']);
  await store.__residentSynchronizeFromSupervisor(supervisor);
  assert.equal(asText(store.__residentGet('home/user/shelf/book.txt')), 'book v2');
}
{
  plain.removeRecursive('/home/user/work');
  plain.rename('/home/user/shelf', '/home/user/cupboard');
  const applied = await barrier();
  assert.deepEqual(
    [...applied.dropped].sort(),
    ['home/user/shelf/book.txt', 'home/user/work/lib/index.js'],
    'a row for a file that is gone was kept',
  );
  const refilled = await store.__residentSynchronizeFromSupervisor(supervisor);
  assert.equal(refilled.failed, 0);
  assert.equal(asText(store.__residentGet('home/user/cupboard/book.txt')), 'book v2');
}
{
  // A's own private /tmp, under its own names; PLAIN hears of it only as B's
  // and A's roots, never by name.
  const all = deltas(() => a.writeFile('/tmp/mine', 'm'));
  assert.ok(all.a.some((entry) => entry.path === 'tmp/mine'));
  hidden({ plain: all.plain }, 'var/agents/a/tmp');
}

console.log('acquire-visibility: ok');
