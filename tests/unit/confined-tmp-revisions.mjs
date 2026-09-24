#!/usr/bin/env bun
// A confined principal's /tmp/x is its own file, not the shared tmp/x, and
// every revision the filesystem bridge reports or checks for it has to be
// that file's. So does every path an ACQUIRE delta names.
//
// list() reports each entry at its storage key's revision. The resident store
// dates a row at that listed revision, fills it with a read conditional on it,
// and evicts it when a delta names it above that revision. If the bridge
// checked the conditional read against the shared file's revision, every fill
// of a confined process's /tmp would fail ESTALE. If the delta named the
// storage key, var/agents/a/tmp/x, a peer's write to the file would never
// evict the row the process holds as tmp/x, and it would serve stale bytes.
//
// Nothing is mocked below the RPC surface: a real SqliteVFS, a process spawned
// with the confined credential, the real fsList / fsReadBatch / fsAcquire
// handlers, and the resident store's shipped source over a real SQLite.

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
const PRIVATE_ROOT = 'var/agents/a/tmp';
const enc = new TextEncoder();
const dec = new TextDecoder();

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const kernel = raw.as(CRED_KERNEL);
kernel.mkdir('tmp', { mode: 0o1777 });
kernel.chmod('tmp', 0o1777);
kernel.mkdir(PRIVATE_ROOT, { recursive: true, mode: 0o755 });
for (const dir of ['var', 'var/agents', 'var/agents/a']) kernel.chmod(dir, 0o755);
kernel.chmod(PRIVATE_ROOT, 0o700);
kernel.chown(PRIVATE_ROOT, A.uid, A.gid);
raw.confinePrincipal(A.uid, PRIVATE_ROOT);

const processes = new SessionProcessSupervisor();
const host = attachSupervisorOps({ sqliteFs: raw, processes, ensureSqliteFs() {} });
const { pid } = processes.spawn('node', ['node'], '/', { cred: A });
const fs = host.supervisorBridge(pid);
const a = raw.as(A);

// The shared tmp/x and A's private /tmp/x, at different revisions.
kernel.writeFile('tmp/x', 'shared');
const sharedRev = raw.revision('tmp/x');
a.writeFile('/tmp/x', 'private v1');
a.writeFile('/tmp/x', 'private v2');
const privateRev = raw.revision('/tmp/x', A);
assert.ok(privateRev > sharedRev);
assert.equal(raw.revision(`${PRIVATE_ROOT}/x`), privateRev);

function listed(bridge, name) {
  let after = null;
  do {
    const page = bridge.list(after, 64);
    for (const entry of page.entries) if (entry.path === name) return entry;
    after = page.next;
  } while (after !== null);
  return undefined;
}

// ── Everything the bridge reports is the private file's revision ──────────
assert.equal(listed(fs, 'tmp/x')?.rev, privateRev, 'list() reports the private file');
assert.equal(fs.revision('/tmp/x'), privateRev, 'revision() reported the shared tmp/x');
assert.equal(fs.stat('/tmp/x').revision, privateRev, 'stat() reported the shared tmp/x');
assert.equal(fs.stat('/tmp/x', { followSymlinks: false }).revision, privateRev);

// ── A read conditional on the listed revision is served ───────────────────
// And one conditional on the shared file's revision is refused: it names a
// state the private file was never in.
assert.equal(
  dec.decode(fs.readRange('/tmp/x', 0, 64, { expectedEpoch: raw.epoch, expectedRevision: privateRev })),
  'private v2',
);
assert.throws(
  () => fs.readRange('/tmp/x', 0, 64, { expectedEpoch: raw.epoch, expectedRevision: sharedRev }),
  { code: 'ESTALE' },
);

// ── Write preconditions and receipts are the private file's too ───────────
assert.throws(() => fs.writeFile('/tmp/x', 'stale', { expectedRevision: sharedRev }), { code: 'ESTALE' });
fs.writeFile('/tmp/x', 'private v3', { expectedRevision: privateRev });
assert.equal(dec.decode(a.readFile('/tmp/x')), 'private v3');
assert.equal(kernel.readFileString('tmp/x'), 'shared', 'the shared tmp/x is untouched');
const beforeRange = raw.revision('/tmp/x', A);
const receipt = fs.writeRange('/tmp/x', 0, enc.encode('P'));
assert.deepEqual(receipt, { before: beforeRange, after: raw.revision() }, 'the receipt dated the shared tmp/x');

// ── ACQUIRE names the caller's own paths ──────────────────────────────────
// A's own write comes back under the name A knows it by, at the revision
// that write produced, so A can recognise it. The shared tmp/x, which A has
// no name for, is not reported to it at all.
{
  const cursor = raw.revision();
  kernel.writeFile('tmp/x', 'shared, rewritten');
  const own = fs.writeFile('/tmp/x', 'private v4');
  const delta = fs.acquire(raw.epoch, cursor);
  assert.equal(delta.poison, false);
  assert.deepEqual(
    delta.paths.filter((entry) => entry.path.startsWith('tmp')).sort((l, r) => (l.path < r.path ? -1 : 1)),
    [{ path: 'tmp', rev: own }, { path: 'tmp/x', rev: own }],
  );
  assert.deepEqual(delta.paths.filter((entry) => entry.path.startsWith('var/agents/a/tmp')), []);

  // An unconfined caller names storage as it is, but only what it could
  // list: the shared tmp/x, and not A's private file, whose root it cannot
  // traverse. The kernel can, and is told of both.
  const session = host.supervisorBridge().acquire(raw.epoch, cursor);
  const names = new Set(session.paths.map((entry) => entry.path));
  assert.ok(names.has('tmp/x'));
  assert.ok(!names.has(`${PRIVATE_ROOT}/x`), 'the session user was told a name in A\'s private root');
  const kernelNames = new Set(kernel.invalidatedSince(raw.epoch, cursor).paths.map((entry) => entry.path));
  assert.ok(kernelNames.has('tmp/x') && kernelNames.has(`${PRIVATE_ROOT}/x`));
}

// ── The resident store keeps A's /tmp coherent ─────────────────────────────
function sqlShim() {
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
}

const store = new Function(
  FACET_RESIDENT_STORE_SOURCE
    + '\nreturn { __residentBind, __residentAdoptModuleBundle, __residentSynchronizeFromSupervisor,'
    + ' __residentAdmit, __residentCursor, __residentGet };',
)();
store.__residentBind({ storage: { sql: sqlShim() } });
const supervisor = {
  fsList: (after, limit) => _rpcFsList(host, after ?? null, limit ?? null, pid),
  fsReadBatch: (requests) => _rpcFsReadBatch(host, requests, pid),
  fsAcquire: (epoch, cursor) => _rpcFsAcquire(host, epoch, cursor, pid),
};
const asText = (cell) => (typeof cell === 'string' ? cell : dec.decode(cell));

store.__residentAdoptModuleBundle({}, { epoch: raw.epoch, rev: raw.revision() });
const filled = await store.__residentSynchronizeFromSupervisor(supervisor);
assert.equal(filled.failed, 0, 'a fill of the private /tmp/x was refused');
assert.equal(asText(store.__residentGet('tmp/x')), 'private v4');

// A peer rewrites A's private file. A knows it only as /tmp/x, so that is the
// name the delta has to evict.
kernel.writeFile(`${PRIVATE_ROOT}/x`, 'a peer wrote this');
const held = store.__residentCursor();
const applied = store.__residentAdmit(await supervisor.fsAcquire(held.epoch, held.rev));
assert.deepEqual(applied.dropped, ['tmp/x'], "a peer's write left A holding the replaced bytes");
assert.equal(store.__residentGet('tmp/x'), undefined);
const refilled = await store.__residentSynchronizeFromSupervisor(supervisor);
assert.equal(refilled.failed, 0);
assert.equal(asText(store.__residentGet('tmp/x')), 'a peer wrote this');

console.log('confined-tmp-revisions: ok');
