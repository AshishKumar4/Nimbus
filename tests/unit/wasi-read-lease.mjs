#!/usr/bin/env bun
/**
 * A WASI process's barrier under its read lease (core
 * runtime/wasi/resident-filesystem.ts): the barrier input owes it asks
 * nothing while the lease is trusted, and asks again once another's change
 * recalled it (a write to the session's own stores included), or once the
 * process changed something itself. Red before:
 * every input cost the next answer an ACQUIRE round trip.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { residentFilesystem } from '../../packages/core/src/runtime/wasi/resident-filesystem.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

const harness = createSqliteVfsTestHarness();
const engine = new SqliteVFS(harness.sql, harness.ctx);
const kernel = engine.as(CRED_KERNEL);
kernel.mkdir('home/user/proj', { recursive: true });
kernel.chown('home/user', 1000, 1000);
kernel.chown('home/user/proj', 1000, 1000);
kernel.writeFile('home/user/proj/a.txt', 'one');
kernel.chown('home/user/proj/a.txt', 1000, 1000);
const files = new ProcessFiles(engine);
const bridge = files.bind({ pid: 7, cred: user });
const peer = files.bind({ pid: 8, cred: user });

// The process's store, read live (coherent at every call): what is counted is
// the barrier, which asks the session as the real store does.
const entryOf = (stat) => ({
  type: stat.type, dev: stat.dev, ino: stat.ino, nlink: stat.nlink, size: stat.size, atime: stat.atime, mtime: stat.mtime,
  ctime: stat.ctime, mode: stat.mode, uid: stat.uid, gid: stat.gid, revision: stat.revision ?? 0, target: null,
});
let cursor = { epoch: engine.epoch, rev: engine.revision() };
let asked = 0;
const store = {
  device: bridge.stat('/').dev,
  cred: user,
  ready: () => true,
  entry: (key) => {
    try {
      const stat = bridge.stat('/' + key, { followSymlinks: false });
      return stat === null ? null : entryOf(stat);
    } catch { return null; }
  },
  children: (key) => { try { return bridge.readdir('/' + key); } catch { return undefined; } },
  list: async () => true,
  lookup: async () => true,
  listTree: async () => false,
  content: (key) => { try { return bridge.readFile('/' + key) ?? undefined; } catch { return undefined; } },
  fill: async (key) => bridge.readFile('/' + key),
  barrier: async (lease) => {
    asked++;
    const answer = bridge.acquire(cursor.epoch, cursor.rev, lease ? { lease: true } : undefined);
    cursor = { epoch: answer.epoch, rev: answer.rev };
    return answer.readLease === undefined ? { ok: true } : { ok: true, readLease: answer.readLease };
  },
  reserve: () => true,
  release: () => {},
};
const fs = residentFilesystem(bridge, store, {
  session: {
    openWriter: async () => null,
    writeBatchStream: async (stream, _fence, owner) => bridge.writeStream(stream, owner === undefined ? {} : { mutationOwner: owner }),
    grants: {
      acquire: async (path, delegate) => bridge.acquireExclusiveMutation(path, { delegate }),
      release: async (owner) => { bridge.releaseExclusiveMutation(owner); },
      awaitRecall: (owner, waitMs) => bridge.awaitRecall(owner, waitMs),
      recalled: async (owner, kind) => { bridge.recalled(owner, kind); },
    },
  },
  isHomeRoot: (key) => key.startsWith('home/') && !key.slice(5).includes('/'),
});

const A = '/home/user/proj/a.txt';
// Input, then an answer: the barrier, which takes the lease.
fs.inbound();
assert.equal((await fs.stat(A)).size, 3);
assert.equal(asked, 1);
// Input again, the lease trusted: the barrier is answered by it.
fs.inbound();
assert.equal((await fs.stat(A)).size, 3);
assert.equal(asked, 1, 'input under a trusted lease asked the session');
assert.equal(fs.stats().leasedBarriers, 1);
// Another's change recalls it, and waits for the process's answer.
await withRecall(() => peer.writeFile(A, 'three'));
fs.inbound();
assert.equal((await fs.stat(A)).size, 5);
assert.equal(asked, 2, 'input after a recall asked nothing');
// Leased again past the hold-off, then a change of its own: the next input asks.
await new Promise((resolve) => setTimeout(resolve, 520));
fs.inbound();
await fs.stat(A);
assert.equal(asked, 3);
await fs.mkdir('/home/user/proj/made', { mode: 0o755 });
fs.inbound();
await fs.stat(A);
assert.equal(asked, 4, 'input after its own change was answered by the lease');
// Its change answered, and confirmed by the next barrier: trusted from here.
await fs.flush();
fs.inbound();
await fs.stat(A);
const trusted = asked;
// A mount is the session's to answer, never the store's: a look at one leaves input to the lease.
assert.ok(await fs.stat('/dev/null'));
fs.inbound();
await fs.stat(A);
assert.equal(asked, trusted, 'input after a look at /dev asked the session');
// The session's own stores are the lease's too: the kernel's synchronous write to one recalls it, and the next input asks.
kernel.mkdir('.nimbus/state', { recursive: true });
assert.ok(await withRecall(() => peer.stat('/.nimbus/state')), 'published once the process answered');
fs.inbound();
await fs.stat(A);
assert.equal(asked, trusted + 1, 'input after a write to the session\'s store was answered by the lease');
await fs.settle();
console.log('wasi-read-lease: ok');
process.exit(0);
