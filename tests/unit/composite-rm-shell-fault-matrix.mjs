#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { VfsError, syscallError } from '../../packages/core/src/vfs/vfs-error.ts';
import { RecallRequired } from '../../packages/core/src/vfs/recall.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { testBox } from './lib/test-box.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

function rooted(view) {
  const at = (path) => '/home/user' + (path.startsWith('/') ? path : '/' + path);
  return new Proxy(view, {
    get(target, key) {
      const value = target[key];
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (key === 'symlink') args[1] = at(args[1]);
        else {
          if (typeof args[0] === 'string') args[0] = at(args[0]);
          if (key === 'rename' && typeof args[1] === 'string') args[1] = at(args[1]);
        }
        return value.apply(target, args);
      };
    },
  });
}

class RootedFiles extends SqliteFiles {
  constructor(engine, cred) { super(engine, rooted(engine.as(cred))); this.store = engine; }
  as(cred) { return new RootedFiles(this.store, cred); }
  stat(path, options) {
    if (path === '/') {
      const stat = this.credentialed.stat('/');
      return { type: stat.type, size: stat.size, mtimeMs: stat.mtime, mode: stat.mode, uid: stat.uid, gid: stat.gid, ino: stat.ino };
    }
    return super.stat(path, options);
  }
}
const cases = [
  { name: 'scandir EACCES, non-empty', fault: 'child-read', kept: ['tree', 'tree/bad', 'tree/bad/secret'], errors: [['/walk/tree/bad', 'Permission denied']] },
  { name: 'scandir EACCES, empty', fault: 'child-read-empty', kept: [], errors: [] },
  { name: 'child lstat EIO, unlink succeeds', fault: 'child-stat', kept: [], errors: [] },
  { name: 'child lstat EIO, unlink fails', fault: 'child-stat-unlink', kept: ['tree', 'tree/bad'], errors: [['/walk/tree/bad', 'Input/output error']] },
  { name: 'vanished child, -r', fault: 'vanished', kept: ['tree'], errors: [['/walk/tree/bad', 'No such file or directory']] },
  { name: 'vanished child, -rf', fault: 'vanished', force: true, kept: [], errors: [] },
  { name: 'symlink-to-directory leaf', fault: 'link', kept: [], errors: [] },
  { name: 'operand stat EACCES', fault: 'operand-stat', kept: ['tree', 'tree/free'], errors: [['/walk/tree', 'Permission denied']] },
  { name: 'operand scandir EACCES', fault: 'operand-read', kept: ['tree', 'tree/free'], errors: [['/walk/tree', 'Permission denied']] },
  // A removal keeps out of a mount; one that asks to be crossed (removalCrosses) is entered, as Linux's rm -r enters one.
  { name: 'writable mounted subtree', fault: 'mount-rw', kept: ['tree'], mounted: ['a', 'b'], errors: [['/walk/tree/mounted', 'Device or resource busy']] },
  { name: 'read-only mounted subtree', fault: 'mount-ro', kept: ['tree'], mounted: ['a', 'b'], errors: [['/walk/tree/mounted', 'Device or resource busy']] },
  { name: 'writable mounted subtree, crossed', fault: 'mount-rw-cross', kept: ['tree'], mounted: [], errors: [['/walk/tree/mounted', 'Device or resource busy']] },
  { name: 'read-only mounted subtree, crossed', fault: 'mount-ro-cross', kept: ['tree'], mounted: ['a', 'b'], errors: [['/walk/tree/mounted/a', 'Read-only file system'], ['/walk/tree/mounted/b', 'Read-only file system']] },
  { name: 'two failed children', fault: 'two-read', kept: ['tree', 'tree/bad', 'tree/bad/secret', 'tree/worse', 'tree/worse/secret'], errors: [['/walk/tree/bad', 'Permission denied'], ['/walk/tree/worse', 'Permission denied']] },
  { name: 'actionable backend detail', fault: 'detail', kept: ['tree', 'tree/bad', 'tree/bad/secret'], errors: [['/walk/tree/bad', 'outside the consented directory']] },
];

function image(root, prefix) {
  const rows = [];
  const visit = (path) => {
    let stat;
    try { stat = root.lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    rows.push(path);
    if (stat.type === 'directory') for (const entry of root.readdir(path)) visit(`${path}/${entry.name}`);
  };
  visit(prefix);
  return rows.sort();
}

async function fixture(test, asynchronous) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const setup = engine.as(CRED_KERNEL);
  setup.mkdir('home/user', { recursive: true });
  setup.chown('home/user', USER.uid, USER.gid);
  const root = rooted(setup);
  root.mkdir('tree');
  root.chown('tree', USER.uid, USER.gid);
  root.writeFile('tree/free', 'free');
  const isRead = ['child-read', 'child-read-empty', 'two-read', 'detail'].includes(test.fault);
  if (isRead) {
    root.mkdir('tree/bad');
    root.chown('tree/bad', USER.uid, USER.gid);
    if (test.fault !== 'child-read-empty') root.writeFile('tree/bad/secret', 'secret');
  }
  if (['child-stat', 'child-stat-unlink', 'vanished'].includes(test.fault)) root.writeFile('tree/bad', 'bad');
  if (test.fault === 'two-read') { root.mkdir('tree/worse'); root.chown('tree/worse', USER.uid, USER.gid); root.writeFile('tree/worse/secret', 'secret'); }
  if (test.fault === 'link') { root.mkdir('outside'); root.writeFile('outside/secret', 'outside'); root.symlink('/outside', 'tree/bad'); }
  let vanish = true;
  class Walked extends RootedFiles {
    removeRecursive = undefined;
    constructor(...args) { super(...args); if (asynchronous) this.sync = undefined; }
    as(cred) { return new Walked(engine, cred); }
    stat(path, options) {
      const read = () => {
        if (test.fault === 'operand-stat' && path === '/tree') throw new VfsError('EACCES', 'permission denied', path);
        if (test.fault.startsWith('child-stat') && path === '/tree/bad') throw syscallError('EIO', 'lstat', path);
        return super.stat(path, options);
      };
      return asynchronous ? Promise.resolve().then(read) : read();
    }
    readdir(path) {
      const read = () => {
        if (test.fault === 'operand-read' && path === '/tree') throw new VfsError('EACCES', 'permission denied', path);
        if (isRead && (path === '/tree/bad' || path === '/tree/worse')) throw new VfsError('EACCES', test.fault === 'detail' ? 'outside the consented directory' : 'permission denied', path);
        const entries = super.readdir(path);
        if (test.fault === 'vanished' && path === '/tree' && vanish) { vanish = false; root.unlink('tree/bad'); }
        return entries;
      };
      return asynchronous ? Promise.resolve().then(read) : read();
    }
    unlink(path) {
      const remove = () => {
        if (test.fault === 'child-stat-unlink' && path === '/tree/bad') throw syscallError('EIO', 'unlink', path);
        return super.unlink(path);
      };
      return asynchronous ? Promise.resolve().then(remove) : remove();
    }
    rmdir(path) { return asynchronous ? Promise.resolve().then(() => super.rmdir(path)) : super.rmdir(path); }
  }
  const backend = new Walked(engine, USER);
  assert.equal(backend.sync === undefined, asynchronous, 'an awaited backend has no synchronous face');
  const box = await testBox({ harness, vfs: engine, mounts: { '/walk': backend } });
  let mounted = null;
  if (test.fault.startsWith('mount-')) {
    const mountedHarness = createSqliteVfsTestHarness();
    const mountedEngine = new SqliteVFS(mountedHarness.sql, mountedHarness.ctx);
    const setupMount = mountedEngine.as(CRED_KERNEL);
    setupMount.mkdir('home/user', { recursive: true });
    setupMount.chown('home/user', USER.uid, USER.gid);
    const mountedRoot = rooted(setupMount);
    mountedRoot.writeFile('a', 'a'); mountedRoot.writeFile('b', 'b');
    box.files.vfs.mount('/walk/tree/mounted', new RootedFiles(mountedEngine, USER), {
      readOnly: test.fault.startsWith('mount-ro'), removalCrosses: test.fault.endsWith('-cross'),
    });
    mounted = { harness: mountedHarness, root: mountedRoot };
  }
  return {
    box, root, mounted,
    async close() { await box.workspace.close(); harness.db.close(); mounted?.harness.db.close(); },
  };
}

const failures = [];
for (const test of cases) for (const asynchronous of [false, true]) {
  const state = await fixture(test, asynchronous);
  try {
    const result = await state.box.workspace.exec(`rm ${test.force ? '-rf' : '-r'} /walk/tree`);
    const actual = image(state.root, 'tree');
    assert.deepEqual(actual, test.kept, `${test.name}: what remains`);
    assert.equal(result.exitCode, test.errors.length ? 1 : 0, `${test.name}: ${result.stderr}`);
    assert.equal(result.stdout, '');
    const lines = result.stderr.trim().split('\n').filter(Boolean).sort();
    const expectedLines = test.errors.map(([path, detail]) => `rm: cannot remove '${path}': ${test.fault === 'detail' ? 'Permission denied: ' : ''}${detail}`).sort();
    assert.deepEqual(lines, expectedLines, `${test.name}: exact diagnostics`);
    if (state.mounted) assert.deepEqual(state.mounted.root.readdir('').map((entry) => entry.name).sort(), test.mounted);
    if (test.fault === 'link') assert.equal(state.root.readFileString('outside/secret'), 'outside', 'rm never follows the directory link leaf');
    console.log(JSON.stringify({ case: test.name, face: asynchronous ? 'async' : 'sync', exit: result.exitCode, kept: actual, stderr: result.stderr }));
  } catch (error) { failures.push(`${test.name} (${asynchronous ? 'async' : 'sync'}): ${error.message}`); }
  finally { await state.close(); }
}

for (const asynchronous of [false, true]) {
  const test = cases[0];
  const direct = await fixture(test, asynchronous);
  const workspace = await fixture(test, asynchronous);
  try {
    const expected = await direct.box.files.vfs.as(USER).removeRecursive('/walk/tree');
    const actual = await workspace.box.workspace.fs.removeRecursive('/walk/tree');
    const view = (report) => ({ removed: report.removed, kept: report.kept, failures: report.failures.map(({ path, error }) => ({ path, code: error.code, syscall: error.syscall, detail: error.detail })), vanished: report.vanished });
    assert.deepEqual(view(actual), view(expected), 'workspace removal keeps the complete namespace report');
    assert.equal(actual.removed.includes('/walk/tree/free'), true);
  } finally { await direct.close(); await workspace.close(); }
}

for (const asynchronous of [false, true]) {
  const state = await fixture(cases[6], asynchronous);
  try {
    const report = await state.box.workspace.fs.removeRecursive('/walk/tree/bad');
    assert.deepEqual(report.removed, ['/walk/tree/bad']);
    assert.deepEqual(report.failures, []);
    assert.equal(state.root.readFileString('outside/secret'), 'outside');
  } finally { await state.close(); }
}

for (const asynchronous of [false, true]) {
  const state = await fixture(cases[2], asynchronous);
  let recalled = 0;
  let pending = true;
  const namespace = state.box.files.vfs.as(USER);
  const backend = (await namespace.route('/walk/tree/bad')).source;
  const stat = backend.stat.bind(backend);
  backend.stat = (path, options) => {
    if (pending && path === '/tree/bad') throw new RecallRequired('tree', 'share', path, async () => { pending = false; recalled++; });
    return stat(path, options);
  };
  try {
    const report = await namespace.removeRecursive('/walk/tree');
    assert.equal(recalled, 1, 'a traversal recall is retried, not recorded as a removal failure');
    assert.deepEqual(report.failures, []);
    assert.equal(state.root.exists('tree'), false);
  } finally { await state.close(); }
}

assert.deepEqual(failures, [], failures.join('\n'));
console.log('composite-rm-shell-fault-matrix: ok');
