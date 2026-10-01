#!/usr/bin/env bun
// `git clone <url> /tmp/x` by a principal whose /tmp is its own.
//
// A confined principal's /tmp/x is var/agents/<p>/tmp/x (SqliteVFS
// confinePrincipal), and a clone writes as the command's credential. The
// clone took its exclusive lease on the name, tmp/x, so every write it made
// landed outside the lease and was refused. Seen on Kinu (0.11.0, 2026-10-01)
// as `EPERM: tmp/main/spoon is outside exclusive mutation root tmp/spoon`
// from `git clone https://github.com/octocat/Spoon-Knife /tmp/spoon`, and
// still so on main before this test: the target is resolved through the
// command's view, which shows the name, not where it is stored.
//
// A real SqliteVFS and the real git command; the network facet is the seam,
// standing in for the clone's writes as the command's credential under the
// lease, as its W7 stream does.

import assert from 'node:assert/strict';
import { runGitCommand } from '../../packages/worker/src/git/commands.ts';
import { adoptCtxExports } from '../../packages/fabric/src/composition.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles, ProcessView } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { stagedAssets } from './lib/staged-assets.mjs';

const A = Object.freeze({ uid: 5001, gid: 5001, groups: Object.freeze([5001]), umask: 0o022 });
const PRIVATE_ROOT = 'var/agents/a/tmp';

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

// The lease the clone takes, as the facet's writes carry it.
const leases = [];
const engine = new Proxy(raw, {
  get(target, key) {
    if (key !== 'as') return Reflect.get(target, key, target);
    return (cred, options) => {
      const view = target.as(cred, options);
      return {
        ...view,
        acquireExclusiveMutation(path, leaseOptions) {
          const lease = view.acquireExclusiveMutation(path, leaseOptions);
          leases.push(lease);
          return lease;
        },
      };
    };
  },
});

const bodies = [];
const writes = [];
adoptCtxExports({ SupervisorRPC() { return { async stdout() {}, [Symbol.dispose]() {} }; } });
const env = {
  ASSETS: stagedAssets,
  LOADER: {
    load() {
      return {
        getEntrypoint() {
          return {
            async fetch(request) {
              const body = await request.json();
              bodies.push(body);
              // What the clone's W7 stream does: write under the destination
              // as the command's credential, carrying the lease's owner.
              try {
                const clone = raw.as(A, { mutationOwner: leases.at(-1).owner });
                clone.mkdir(body.dir, { recursive: true });
                clone.writeFile(`${body.dir}/README.md`, 'spoon');
                writes.push('ok');
              } catch (error) {
                writes.push(`${error.code}: ${error.message}`);
              }
              return Response.json({ success: false, error: 'capture-only' });
            },
          };
        },
      };
    },
  },
};

const ctx = {
  pid: 7,
  cred: A,
  args: ['clone', 'https://github.com/octocat/Spoon-Knife', '/tmp/spoon'],
  cwd: '/tmp',
  env: {},
  stdout: { write() {} },
  stderr: { write() {} },
  vfs: new ProcessView(new ProcessFiles(raw).bind({ pid: 7, cred: A })),
};
const doCtx = { id: { toString: () => 'do-confined-clone' }, waitUntil() {} };

try {
  await runGitCommand(ctx, engine, doCtx, env);
  assert.ok(bodies.length >= 1, 'the clone reached the facet');
  assert.equal(bodies[0].dir, '/tmp/spoon', 'the facet clones into the name the command gave');
  assert.equal(bodies[0].exclusiveMutationRoot, 'tmp/spoon', 'and is told its root under that name, which covers it');
  assert.equal(writes[0], 'ok', `the clone's writes fit its lease: ${writes[0]}`);
  assert.equal(raw.as(A).readFileString('/tmp/spoon/README.md'), 'spoon', 'the file is in the principal\'s own /tmp');
  assert.equal(kernel.exists(`${PRIVATE_ROOT}/spoon/README.md`), true, 'which is its private root');
  assert.equal(kernel.exists('tmp/spoon'), false, 'not the shared tmp/spoon');
  assert.equal(raw.hasExclusiveMutation(), false, 'the lease is released when the clone ends');
} finally {
  adoptCtxExports(undefined);
}

// The lease is on the private key: the shared name stays writable, and the
// private one is held from everyone else while it lasts.
{
  const lease = raw.as(A).acquireExclusiveMutation('/tmp/held', { includeMissingAncestors: true });
  assert.equal(lease.root, 'tmp/held', 'the lease names its root as the caller does');
  kernel.writeFile('tmp/held', 'shared');
  assert.throws(() => kernel.writeFile(`${PRIVATE_ROOT}/held`, 'peer'), { code: 'EBUSY' });
  assert.throws(() => raw.as(A).writeFile('/tmp/held', 'self, unleased'), { code: 'EBUSY' }, 'the caller\'s own write without the lease too');
  raw.releaseExclusiveMutation(lease.owner);
}

// Every mutation is checked where it lands, not by the name it was asked
// by: a lease on the shared tmp/x refused a confined caller's write to its
// own /tmp/x (EBUSY on main), and a write through a symlink into a held
// tree is refused for the tree it reaches.
{
  const shared = raw.acquireExclusiveMutation('tmp/x', { includeMissingAncestors: true });
  raw.as(A).writeFile('/tmp/x', 'mine');
  assert.equal(kernel.readFileString(`${PRIVATE_ROOT}/x`), 'mine', 'the caller\'s own /tmp/x is not the held shared one');
  // A process writes through the runtime bridge, which checks leases itself first.
  new SqliteRuntimeFsBridge(raw.as(A), raw).writeFile('/tmp/x', 'mine, from a process');
  assert.equal(kernel.readFileString(`${PRIVATE_ROOT}/x`), 'mine, from a process');
  raw.releaseExclusiveMutation(shared.owner);
  const held = raw.acquireExclusiveMutation(`${PRIVATE_ROOT}/x`);
  assert.throws(() => new SqliteRuntimeFsBridge(raw.as(A), raw).writeFile('/tmp/x', 'held'), { code: 'EBUSY' }, 'while its own private file is held');
  raw.releaseExclusiveMutation(held.owner);
}
{
  kernel.mkdir('home/user', { recursive: true, mode: 0o777 });
  kernel.symlink('/home/held', 'home/user/into-held');
  const lease = raw.acquireExclusiveMutation('home/held', { includeMissingAncestors: true });
  assert.equal(lease.root, 'home/held');
  raw.as(CRED_KERNEL, { mutationOwner: lease.owner }).mkdir('/home/held');
  const writes = {
    writeFile: () => kernel.writeFile('home/user/into-held/f', 'x'),
    mkdir: () => kernel.mkdir('home/user/into-held/d', { recursive: true }),
    rename: () => { kernel.writeFile('home/user/g', 'g'); kernel.rename('home/user/g', 'home/user/into-held/g'); },
    copyFile: () => { kernel.writeFile('home/user/h', 'h'); kernel.copyFile('home/user/h', 'home/user/into-held/h'); },
    copyTree: () => { kernel.mkdir('home/user/tree', { recursive: true }); kernel.writeFile('home/user/tree/t', 't'); kernel.copyTree('home/user/tree', 'home/user/into-held/tree'); },
  };
  for (const [name, write] of Object.entries(writes)) {
    assert.throws(write, { code: 'EBUSY' }, `${name} through a link into the held tree is refused`);
  }
  assert.equal(kernel.exists('home/held/tree'), false, 'and copied nothing in');
  raw.releaseExclusiveMutation(lease.owner);
}

// A copy in slices is checked again on each one: a lease taken over its
// destination between two slices stops the rest. A slice is 200 pages of
// 250 rows, so the source is one row more than a slice.
{
  kernel.mkdir('home/user/big', { recursive: true });
  for (let page = 0; page < 200; page++) kernel.mkdirBatch(Array.from({ length: 250 }, (_, i) => `home/user/big/d${page * 250 + i}`));
  const copying = kernel.copyTreeAsync('home/user/big', 'home/user/copy');
  const lease = raw.acquireExclusiveMutation('home/user/copy', { includeMissingAncestors: true });
  await assert.rejects(copying, { code: 'EBUSY' }, 'the copy stops at the lease');
  raw.releaseExclusiveMutation(lease.owner);
}

console.log('git clone into a confined /tmp: ok');
