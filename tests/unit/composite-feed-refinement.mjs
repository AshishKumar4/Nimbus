#!/usr/bin/env bun
// Refinement bridge for Nimbus.Vfs.CompositeFeed (FormalModelsLane 6da08f76)
// (lean/fixtures/composite-feed.json). A reader stages the composite's
// namespace through ProcessFiles' launch-named, bound listing, a window of
// operations runs (writes straight into a backend, shadowed ones included;
// mounts appearing and going), and an answer applies the filtered feed while
// retaining unfed observations. Boot/relist replaces that partial walk;
// resident reconciliation refetches mounted bytes the listing cannot date.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { sqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { createAuthority, facetSql, facetSupervisor } from './lib/resident-body.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const fixture = JSON.parse(readFileSync(new URL('../../lean/fixtures/composite-feed.json', import.meta.url), 'utf8'));
const enc = new TextEncoder();
const dec = new TextDecoder();

function backend(changes, entries) {
  let files;
  if (changes) {
    const harness = createSqliteVfsTestHarness();
    files = sqliteFiles(new SqliteVFS(harness.sql, harness.ctx), CRED_KERNEL);
  } else {
    files = new MemoryVFS();
  }
  for (const [path, value] of Object.entries(entries).sort(([a], [b]) => (a < b ? -1 : 1))) write(files, path, value);
  return files;
}

function parentOf(path) {
  const at = path.lastIndexOf('/');
  return at <= 0 ? '/' : path.slice(0, at);
}

function write(files, path, value) {
  const parent = parentOf(path);
  if (parent !== '/') files.mkdir(parent, { recursive: true });
  if (value === 'dir') {
    const stat = files.stat(path, { follow: false });
    if (stat !== null && stat.type !== 'directory') files.unlink(path);
    if (stat === null || stat.type !== 'directory') files.mkdir(path, { recursive: true });
    return;
  }
  const stat = files.stat(path, { follow: false });
  if (stat !== null && stat.type === 'directory') files.removeRecursive(path);
  files.writeFile(path, enc.encode(value));
}

function remove(files, path) {
  if (files.stat(path, { follow: false }) !== null) files.removeRecursive(path);
}

async function valueOf(vfs, entry) {
  if (entry.kind === 'directory') return 'dir';
  return dec.decode(await vfs.readFile(entry.path));
}

async function listAll(bridge, vfs, betweenPages) {
  const out = {};
  const undated = [];
  const unlisted = {};
  let after = null;
  let pages = 0;
  for (;;) {
    const page = await bridge.list(after, 3);
    pages++;
    for (const entry of page.entries) {
      const path = `/${entry.path}`;
      out[path] = await valueOf(vfs, { ...entry, path });
      if (entry.rev === 0) undated.push(path);
      if (entry.unlisted !== undefined) unlisted[path] = entry.unlisted;
    }
    if (page.next === null) return { tree: out, undated: undated.sort(), unlisted, cursor: page, pages };
    if (pages === 1 && betweenPages) await betweenPages();
    after = page.next;
  }
}

function dropTree(staged, path) {
  for (const key of Object.keys(staged)) if (key === path || key.startsWith(`${path}/`)) delete staged[key];
}

/** What a namespace reader does with one delta entry. */
async function apply(vfs, staged, entry) {
  const stat = entry.stat;
  if (stat === null || stat === undefined || entry.subtree || entry.structural || stat.type !== 'directory') {
    dropTree(staged, entry.path);
  }
  if (stat === null || stat === undefined) return;
  staged[entry.path] = stat.type === 'directory' ? 'dir' : dec.decode(await vfs.readFile(entry.path));
  if (stat.type === 'directory' && (entry.subtree || entry.structural)) {
    // Relist what is under it, as a reader does for a structural change.
    const walk = async (dir) => {
      for (const child of await vfs.readdir(dir)) {
        const at = dir === '/' ? `/${child.name}` : `${dir}/${child.name}`;
        const childStat = await vfs.stat(at, { follow: false });
        staged[at] = childStat.type === 'directory' ? 'dir' : dec.decode(await vfs.readFile(at));
        if (childStat.type === 'directory') await walk(at);
      }
    };
    await walk(entry.path);
  }
}

const sorted = (tree) => Object.fromEntries(Object.entries(tree).sort(([a], [b]) => (a < b ? -1 : 1)));

function asynchronous(files) {
  return new Proxy(files, {
    get(target, key) {
      if (key === 'sync') return undefined;
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? async (...args) => Reflect.apply(value, target, args) : value;
    },
    has(target, key) { return key !== 'sync' && Reflect.has(target, key); },
  });
}

async function cacheTrace(testCase) {
  const authority = createAuthority();
  const backends = new Map();
  for (const mount of testCase.mounts) {
    const mounted = backend(mount.changes, mount.entries);
    authority.files.vfs.mount(mount.point, asynchronous(mounted));
    backends.set(mount.point, mounted);
  }
  const store = createResidentStore();
  store.bind({ storage: { sql: facetSql() } });
  const path = testCase.cache.path.slice(1);
  const held = () => {
    const bytes = store.cells.get(path);
    return bytes === null || bytes === undefined ? 'EAGAIN'
      : { bytes: dec.decode(bytes), rev: store.coherence.tables('refinement').fileRev(path) };
  };
  let inspectDrop = false;
  let sawDrop = false;
  const handle = facetSupervisor(authority, {
    fsReadBatch: (requests) => {
      if (inspectDrop) {
        assert.deepEqual(held(), testCase.cache.afterDrop, 'reconciliation removes unvouched mounted bytes before refetch');
        inspectDrop = false;
        sawDrop = true;
      }
      return handle.forward('fsReadBatch', [requests]);
    },
  });
  const binding = { pid: handle.log.pid, cred: authority.host.processes.cred(handle.log.pid) };
  authority.files.nameLaunch(binding, () => testCase.launchNames);
  store.sync.setPlan([path]);
  store.sync.adoptModuleBundle({}, authority.cursor());
  try {
    const boot = await store.sync.synchronize(handle.supervisor);
    assert.equal(boot.filled, 1, 'the asynchronous mount fills the wanted file');
    assert.deepEqual(held(), testCase.cache.before, 'the resident holds the walked, undated bytes');
    for (const op of testCase.window) write(backends.get(op.backend), op.path, op.bytes);
    const cursor = store.coherence.cursor();
    const answer = await handle.supervisor.fsAcquire(cursor.epoch, cursor.rev, { namespace: true });
    assert.equal(answer.poison, false);
    assert.deepEqual(answer.paths, [], 'unfed external writes have no incremental record');
    await store.sync.applyAcquire(handle.supervisor, answer);
    assert.deepEqual(held(), testCase.cache.afterAcquire, 'an ordinary acquire retains the unfed observation');
    inspectDrop = true;
    await store.sync.synchronize(handle.supervisor);
    assert.equal(sawDrop, true, 'the new listing did not vouch for revision 0');
    assert.deepEqual(held(), testCase.cache.afterReconcile, 'reconciliation refetches the mounted bytes');
  } finally {
    await authority.files.releaseProcess(binding.pid);
  }
}

let failures = 0;
let poisons = 0;
for (const [index, testCase] of fixture.cases.entries()) {
  try {
    const harness = createSqliteVfsTestHarness();
    const engine = new SqliteVFS(harness.sql, harness.ctx);
    const root = sqliteFiles(engine, CRED_KERNEL);
    for (const [path, value] of Object.entries(testCase.root)) write(root, path, value);
    const byPoint = new Map([['root', root]]);
    const files = new ProcessFiles(engine);
    const vfs = files.vfs;
    for (const mount of testCase.mounts) {
      const files = backend(mount.changes, mount.entries);
      byPoint.set(mount.point, files);
      vfs.mount(mount.point, files);
    }
    const binding = { pid: 1, cred: CRED_KERNEL };
    files.nameLaunch(binding, () => testCase.launchNames ?? testCase.mounts.map((mount) => mount.point));
    const bridge = files.bind(binding);
    const position = vfs.feed.position();
    const listed = await listAll(bridge, vfs, testCase.betweenPages && (() => {
      for (const op of testCase.betweenPages) write(byPoint.get(op.backend), op.path, op.bytes);
    }));
    if (testCase.betweenPages) assert.ok(listed.pages > 1, 'the mutation occurred between continuing pages');
    const staged = listed.tree;
    assert.deepEqual(sorted(staged), sorted(testCase.atCursor), 'the staged namespace after boot');
    if (testCase.atCursorUndated) assert.deepEqual(listed.undated, testCase.atCursorUndated);
    if (testCase.atCursorUnlisted) assert.deepEqual(sorted(listed.unlisted), sorted(testCase.atCursorUnlisted));
    for (const op of testCase.window) {
      if (op.op === 'mount') {
        const files = backend(op.changes, op.entries);
        byPoint.set(op.point, files);
        vfs.mount(op.point, files);
      } else if (op.op === 'unmount') {
        vfs.unmount(op.point);
      } else {
        const files = byPoint.get(op.backend);
        if (op.op === 'write') write(files, op.path, op.bytes ?? 'dir');
        else remove(files, op.path);
      }
    }
    // ProcessFiles' session cursor dates SQLite, not independent fed backends.
    // Keep the general composite-feed cases on their multi-feed position.
    const independentFeeds = testCase.mounts.some((mount) => mount.changes) || testCase.window.some((op) => op.op === 'mount' && op.changes);
    const answer = independentFeeds
      ? vfs.feed.since(position, { namespace: true })
      : bridge.acquire(listed.cursor.epoch, listed.cursor.rev, { namespace: true });
    assert.equal(answer.poison, testCase.poison, 'poison exactly when the model says');
    if (answer.poison) {
      poisons++;
      assert.deepEqual(sorted((await listAll(bridge, vfs)).tree), sorted(testCase.atAnswer), 'the relisted namespace');
    } else {
      for (const entry of answer.paths) await apply(vfs, staged, independentFeeds ? entry : { ...entry, path: `/${entry.path}` });
      assert.deepEqual(sorted(staged), sorted(testCase.atAnswer), 'the namespace after one answer');
    }
    if (testCase.atRelist) assert.deepEqual(sorted((await listAll(bridge, vfs)).tree), sorted(testCase.atRelist), 'a new listing replaces the held walk');
    await files.releaseProcess(binding.pid);
    if (testCase.cache) await cacheTrace(testCase);
  } catch (error) {
    failures++;
    if (failures <= 5) console.log(`FAIL case ${index}: ${error.message.split('\n')[0]}\n  ${JSON.stringify(error.actual)}\n  vs ${JSON.stringify(error.expected)}`);
  }
}
if (failures > 0) {
  console.log(`composite-feed-refinement: ${failures} of ${fixture.cases.length} cases disagree with the model`);
  process.exit(1);
}
console.log(`composite-feed-refinement: ${fixture.cases.length} cases of lean/fixtures/composite-feed.json agree with the model (${poisons} poisons)`);
