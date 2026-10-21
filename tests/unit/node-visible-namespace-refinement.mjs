#!/usr/bin/env bun
// Refinement bridge for Nimbus.Coherence.Relist.relist_exact
// (lean/fixtures/node-visible-namespace.json). Each case builds a tree as the
// kernel (setup), boots a reader's resident store over the real supervisor
// RPC handlers, and requires its namespace to be exactly what the reader may
// see (atCursor). Then the window runs, the store takes one namespace ACQUIRE
// and the relists that answer asks for, and the namespace must be exactly
// atAnswer: a name that stopped being visible is gone, one that became
// visible is there, whether or not any delta entry named it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { _rpcFsAcquire, _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { kvTables } from '../../packages/worker/src/vfs/resident/kv-tables.ts';
import { NS_DIR } from '../../packages/worker/src/vfs/resident/tables.ts';
import { facetSql } from './lib/resident-body.mjs';
import { facetStorage } from './lib/fake-do-kv.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { attachSupervisorOps } from './lib/session-supervisor-ops.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/node-visible-namespace.json', import.meta.url), 'utf8'));
assert.equal(fixture.fixture, 'node-visible-namespace');
assert.ok(fixture.cases.length > 0);
const reader = Object.freeze({ ...fixture.reader, groups: Object.freeze([...fixture.reader.groups]) });

function apply(vfs, step, where) {
  switch (step.op) {
    case 'mkdir': vfs.mkdir(step.path, { mode: step.mode }); vfs.chmod(step.path, step.mode); return;
    case 'write': vfs.writeFile(step.path, where); return;
    case 'chmod': vfs.chmod(step.path, step.mode); return;
    case 'rmrf': vfs.removeRecursive(step.path); return;
    case 'rename': vfs.rename(step.path, step.to); return;
    default: throw new Error(`${where}: unknown op ${step.op}`);
  }
}

function residentStore() {
  const storage = facetStorage(facetSql());
  const store = createResidentStore();
  store.bind({ storage });
  // The rows the store left, read by a second binding over the same storage.
  const rows = kvTables(storage);
  /** The namespace as the fixture states it: path → "dir" | "file". */
  const namespace = () => {
    const out = {};
    for (const key of rows.nsKeys()) {
      // The kernel's mounts are every reader's now; the fixture states the reader's own names.
      if (key.name === 'dev' || key.name === 'proc' || key.parent === 'dev' || key.parent.startsWith('dev/') || key.parent === 'proc' || key.parent.startsWith('proc/')) continue;
      const row = rows.nsGet(key.parent, key.name);
      out[key.parent ? `${key.parent}/${key.name}` : key.name] = row.kind === NS_DIR ? 'dir' : 'file';
    }
    return out;
  };
  return { store, namespace };
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));

let relists = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  const where = `case ${index}`;
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  for (const step of testCase.setup) apply(kernel, step, where);

  const processes = new SessionProcessSupervisor();
  const host = attachSupervisorOps({ sqliteFs: raw, processes, ensureSqliteFs() {} });
  const { pid } = processes.spawn('node', ['node'], '/', { cred: reader });
  const supervisor = {
    fsList: (after, limit) => _rpcFsList(host, after ?? null, limit ?? null, undefined, pid),
    fsReadBatch: (requests) => _rpcFsReadBatch(host, requests, pid),
    fsAcquire: (position, options) => _rpcFsAcquire(host, position, options, pid),
  };
  const { store, namespace } = residentStore();
  store.namespace.setCred(reader);
  store.sync.adoptModuleBundle({}, (await supervisor.fsAcquire(null)).position);
  await store.sync.synchronize(supervisor);
  assert.ok(store.namespace.ready(), `${where}: the namespace was not built`);
  assert.deepEqual(sorted(namespace()), sorted(testCase.atCursor), `${where}: namespace at the cursor`);

  for (const step of testCase.window) apply(kernel, step, where);
  const held = store.coherence.cursor();
  const applied = store.cells.admit(await supervisor.fsAcquire(held, store.sync.acquireOptions()));
  for (const dir of applied.relist) {
    relists++;
    await store.transport.relist(supervisor, dir);
  }
  assert.ok(store.namespace.ready(), `${where}: the namespace went unready`);
  assert.deepEqual(sorted(namespace()), sorted(testCase.atAnswer), `${where}: namespace after one ACQUIRE`);
}

console.log(`node-visible-namespace-refinement: ${fixture.cases.length} cases of lean/fixtures/node-visible-namespace.json agree with the model (${relists} relists)`);
