#!/usr/bin/env bun
// rm -r is one contract, whoever carries it out. SqliteVFS removes a tree
// itself (the composite's native arm, the bridge's direct removal, a W7
// apply); CompositeVFS walks one entry by entry over a backend that cannot.
// Over the same tree, with real permissions refusing some of it, both leave
// the same tree and say the same: what went, what stayed, and why, as GNU
// rm -r does (a refused entry stays, with the directories holding it; the
// walk carries on past it).
//   1. the report and what remains, native against walked, per case;
//   2. the shell's rm -r, native against walked: exit, stderr and what remains;
//   3. the bridge's direct removal of a tree in the store throws the first
//      refusal, after removing the rest;
//   4. a refused entry deep in a tree larger than one commit group: every
//      other entry goes.
import assert from 'node:assert/strict';
import { SqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { testBox } from './lib/test-box.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const BOB = { uid: 2000, gid: 2000, groups: [2000], umask: 0o022 };

/** Each case seeds home/tree (the user's, in the user's home) through `root`, `user` and `bob` views of the store. */
const cases = {
  'nothing refused': ({ user }) => {
    user.mkdir('home/tree/a/b', { recursive: true });
    user.writeFile('home/tree/a/b/f', 'f');
  },
  'a directory the user may not read': ({ user }) => {
    user.mkdir('home/tree/closed', { recursive: true });
    user.writeFile('home/tree/closed/secret', 's');
    user.writeFile('home/tree/free', 'f');
    user.chmod('home/tree/closed', 0o300);
  },
  'an empty directory the user may not read': ({ user }) => {
    user.mkdir('home/tree/closed', { recursive: true });
    user.chmod('home/tree/closed', 0o300);
  },
  'a directory the user may not write': ({ user }) => {
    user.mkdir('home/tree/ro', { recursive: true });
    user.writeFile('home/tree/ro/f', 'f');
    user.writeFile('home/tree/free', 'f');
    user.chmod('home/tree/ro', 0o555);
  },
  "another user's file in a sticky directory": ({ root, user, bob }) => {
    user.mkdir('home/tree', { recursive: true });
    root.mkdir('home/tree/tmp', { mode: 0o777 });
    root.chmod('home/tree/tmp', 0o1777);
    bob.writeFile('home/tree/tmp/bob.txt', 'bob');
    user.writeFile('home/tree/tmp/mine.txt', 'mine');
    user.writeFile('home/tree/free', 'f');
  },
  'an operand in a directory the user may not write': ({ user }) => {
    user.mkdir('home/tree/inner', { recursive: true });
    user.writeFile('home/tree/inner/f', 'f');
    user.chmod('home', 0o555);
  },
};

function world(seed, native) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const root = engine.as(CRED_KERNEL);
  root.mkdir('home', { mode: 0o755 });
  root.chown('home', USER.uid, USER.gid);
  seed({ root, user: engine.as(USER), bob: engine.as(BOB) });
  class Walked extends SqliteFiles {
    removeRecursive = undefined;
    as(cred, actor, options) { return new Walked(engine, engine.as(cred, { ...options, actor })); }
  }
  class Native extends SqliteFiles {
    as(cred, actor, options) { return new Native(engine, engine.as(cred, { ...options, actor })); }
  }
  const backend = native ? new Native(engine, engine.as(USER)) : new Walked(engine, engine.as(USER));
  return { harness, engine, root, backend };
}

/** Every path left in the store, as root sees it. */
function image(root) {
  const rows = [];
  const visit = (path) => {
    let stat;
    try { stat = root.lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    rows.push(path);
    if (stat.type === 'directory') for (const entry of root.readdir(path)) visit(`${path}/${entry.name}`);
  };
  visit('home');
  return rows.sort();
}
const view = (report) => ({
  removed: report.removed, kept: report.kept, vanished: report.vanished,
  failures: report.failures.map(({ path, error }) => ({ path, code: error.code, syscall: error.syscall, detail: error.detail })),
});

const failures = [];
async function check(name, body) {
  try { await body(); console.log(`ok   ${name}`); } catch (error) { failures.push(`${name}: ${error.message}`); console.log(`FAIL ${name}: ${error.message}`); }
}

// ── 1. the report and what remains ────────────────────────────────────────
for (const [name, seed] of Object.entries(cases)) {
  await check(`report: ${name}`, async () => {
    const outcome = async (native) => {
      const w = world(seed, native);
      const box = await testBox({ harness: w.harness, vfs: w.engine, mounts: { '/walk': w.backend } });
      try {
        const report = await box.files.vfs.as(USER).removeRecursive('/walk/home/tree');
        return { report: view(report), left: image(w.root) };
      } finally { await box.workspace.close(); w.harness.db.close(); }
    };
    const walked = await outcome(false);
    assert.deepEqual(await outcome(true), walked);
  });
}

// ── 2. the shell's rm -r ──────────────────────────────────────────────────
for (const [name, seed] of Object.entries(cases)) {
  await check(`shell: ${name}`, async () => {
    const outcome = async (native) => {
      const w = world(seed, native);
      const box = await testBox({ harness: w.harness, vfs: w.engine, mounts: { '/walk': w.backend } });
      try {
        const result = await box.workspace.exec('rm -r /walk/home/tree');
        return { exit: result.exitCode, stderr: result.stderr.trim().split('\n').filter(Boolean).sort(), left: image(w.root) };
      } finally { await box.workspace.close(); w.harness.db.close(); }
    };
    const walked = await outcome(false);
    assert.deepEqual(await outcome(true), walked);
  });
}

// ── 3. the bridge's direct removal of a tree in the store ─────────────────
await check('bridge: the first refusal is thrown after the rest went', async () => {
  const w = world(cases["another user's file in a sticky directory"], true);
  const files = new ProcessFiles(w.engine);
  const bridge = files.bind({ pid: 7, cred: USER });
  assert.throws(() => bridge.remove('/home/tree', { recursive: true }), (error) => error.code === 'EPERM');
  assert.deepEqual(image(w.root), ['home', 'home/tree', 'home/tree/tmp', 'home/tree/tmp/bob.txt']);
  w.harness.db.close();
});

// ── 4. a refusal in a tree larger than one commit group ───────────────────
await check('large tree: everything but the refused entry goes', async () => {
  const w = world(({ root, user, bob }) => {
    for (let d = 0; d < 30; d++) {
      user.mkdir(`home/tree/d${d}`, { recursive: true });
      for (let f = 0; f < 120; f++) user.writeFile(`home/tree/d${d}/f${f}`, 'x');
    }
    root.mkdir('home/tree/d29/tmp', { mode: 0o777 });
    root.chmod('home/tree/d29/tmp', 0o1777);
    bob.writeFile('home/tree/d29/tmp/bob.txt', 'bob');
  }, true);
  const before = w.harness.transactionCount;
  const report = w.engine.as(USER).removeRecursive('home/tree');
  const transactions = w.harness.transactionCount - before;
  assert.deepEqual(view(report).failures, [{ path: 'home/tree/d29/tmp/bob.txt', code: 'EPERM', syscall: 'unlink', detail: report.failures[0].error.detail }]);
  assert.deepEqual(image(w.root), ['home', 'home/tree', 'home/tree/d29', 'home/tree/d29/tmp', 'home/tree/d29/tmp/bob.txt']);
  assert.ok(transactions >= 2 && transactions <= 3600 / 8, `${transactions} transactions: more than one group, never one per entry`);
  assert.equal(w.engine._verifyCounters(), null, 'the counters follow every group');
  w.harness.db.close();
});

if (failures.length > 0) {
  console.log(`removal-native-walk-parity: ${failures.length} failed`);
  process.exit(1);
}
console.log('removal-native-walk-parity: ok');
