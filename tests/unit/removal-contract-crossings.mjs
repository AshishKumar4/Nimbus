#!/usr/bin/env bun
// rm -r's contract holds wherever the call crosses to another layer:
//   1. over the supervisor RPC: a process's removeRecursive gets its report,
//      and its strict vanished-ancestor policy reaches the session;
//   2. on an asynchronous-only mount: remove(path, { force: true }) of a path
//      that is not there succeeds, as it does on every other mount;
//   3. a revision through a link into another holder's delegation waits for
//      its recall and answers the path the link leads to;
//   4. into a mounted CompositeVFS: the strict policy keeps the ancestors of
//      a child that vanished mid-walk, as the same removal does unmounted.
// Each case reports its own failure; the run fails if any does.
import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteFiles } from '../../packages/core/src/vfs/sqlite-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { supervisorFilesystem } from '../../packages/core/src/runtime/vfs-supervisor.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { createAuthority } from './lib/resident-body.mjs';
import { processInstanceSupervisor } from './lib/process-instance-supervisor.mjs';
import { testBox } from './lib/test-box.mjs';
import { asyncOnly } from './lib/async-memory-vfs.mjs';

const USER = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
let failures = 0;
async function check(name, body) {
  try {
    await body();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}: ${error?.message ?? error}`);
  }
}

// ── 1. over the supervisor RPC ────────────────────────────────────────────
await check('a removal over the supervisor RPC answers its report', async () => {
  const authority = createAuthority();
  authority.kfs.mkdir('home/user/tree/sub', { recursive: true });
  authority.kfs.writeFile('home/user/tree/sub/f', 'f');
  const instance = processInstanceSupervisor(authority, USER);
  try {
    const view = new ProcessView(supervisorFilesystem(instance.supervisor));
    const report = await view.removeRecursive('/home/user/tree', { keepVanishedAncestors: true });
    assert.deepEqual({ removed: report.removed, kept: report.kept, failures: report.failures.length },
      { removed: ['/home/user/tree'], kept: [], failures: 0 });
    assert.equal(authority.rawVfs.as(CRED_KERNEL).exists('home/user/tree'), false);
  } finally {
    await instance.close();
  }
});

// ── 2. an asynchronous-only mount ─────────────────────────────────────────
await check('remove with force of a missing path on an asynchronous-only mount succeeds', async () => {
  const box = await testBox({ mounts: { '/m': asyncOnly(new MemoryVFS({ uid: 1000, gid: 1000 }), { deep: true }) } });
  try {
    const bridge = box.workspace.filesystem.bind({ pid: 71, cred: USER });
    await bridge.remove('/m/missing', { force: true });
    await bridge.remove('/m/missing-tree', { recursive: true, force: true });
    await assert.rejects(Promise.resolve().then(() => bridge.remove('/m/missing')), { code: 'ENOENT' }, 'without force it is ENOENT');
  } finally {
    await box.workspace.close();
  }
});

// ── 3. a revision through a link into another holder's delegation ─────────
await check("a revision through a link into a delegation waits for its recall and answers the link's path", async () => {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('home/user/repo/sub', { recursive: true });
  kernel.writeFile('home/user/repo/f', 'stored');
  kernel.writeFile('home/user/f', 'the lexical name');
  kernel.symlink('repo/sub', 'home/user/link');
  const recalls = [];
  let owned;
  const lease = raw.acquireExclusiveMutation('home/user/repo', {
    delegation: {
      reads: true,
      async recall(kind) {
        recalls.push(kind);
        await new Promise((resolve) => setTimeout(resolve, 2));
        owned.writeFile('home/user/repo/f', 'by the holder');
      },
    },
  });
  owned = raw.as(CRED_KERNEL, { mutationOwner: lease.owner });
  const seen = await withRecall(() => kernel.revision('home/user/link/../f'));
  assert.ok(recalls.length >= 1, 'the holder was recalled');
  assert.equal(seen, kernel.revision('home/user/repo/f'), "the revision is that of the link's path, after the holder's write");
  assert.notEqual(seen, kernel.revision('home/user/f'), 'not the lexical name\'s');
  harness.db.close();
});

// ── 4. into a mounted CompositeVFS ────────────────────────────────────────
await check('the strict policy reaches a mounted CompositeVFS', async () => {
  const outcome = async (mounted) => {
    const harness = createSqliteVfsTestHarness();
    const engine = new SqliteVFS(harness.sql, harness.ctx);
    const root = engine.as(CRED_KERNEL);
    root.mkdir('tree/deep', { recursive: true });
    root.chown('tree', USER.uid, USER.gid);
    root.chown('tree/deep', USER.uid, USER.gid);
    root.writeFile('tree/deep/bad', 'bad');
    root.writeFile('tree/free', 'free');
    let vanish = true;
    class Walked extends SqliteFiles {
      removeRecursive = undefined;
      as(cred, actor, options) { return new Walked(engine, engine.as(cred, { ...options, actor })); }
      readdir(path) {
        const entries = super.readdir(path);
        if (path === '/tree/deep' && vanish) { vanish = false; root.unlink('tree/deep/bad'); }
        return entries;
      }
    }
    const inner = new CompositeVFS(new Walked(engine, engine.as(USER)));
    let report;
    if (mounted) {
      const outer = new CompositeVFS(new MemoryVFS({ uid: 1000, gid: 1000 }));
      outer.mount('/mount', inner);
      report = outer.sync.removeRecursive('/mount/tree', { keepVanishedAncestors: true });
    } else {
      report = inner.sync.removeRecursive('/tree', { keepVanishedAncestors: true });
    }
    const left = ['tree', 'tree/deep', 'tree/free'].filter((path) => root.exists(path));
    harness.db.close();
    const strip = (path) => path.replace(/^\/mount/, '');
    return { left, kept: report.kept.map(strip), vanished: (report.vanished ?? []).map(strip) };
  };
  const direct = await outcome(false);
  assert.ok(direct.left.includes('tree/deep'), `unmounted, the vanished child's ancestors stay (${JSON.stringify(direct)})`);
  assert.deepEqual(await outcome(true), direct, 'mounted, the same removal leaves the same tree and says the same');
});

if (failures > 0) {
  console.log(`removal-contract-crossings: ${failures} case(s) failed`);
  process.exit(1);
}
console.log('removal-contract-crossings: ok');
