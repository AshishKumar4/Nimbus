#!/usr/bin/env bun
// The bridge over a supervisor (a facet's filesystem: core
// supervisorFilesystem over the SupervisorRPC binding) answers every call as
// the bridge the session serves it from does, the call's options included:
// a write that makes its parents, a write's mask, a write or read that names
// the revision it is of, a read that does not follow a link or reads at most
// so many bytes, a listing that leaves out what it was not asked for.
//
// Real code on both sides: SupervisorRPC, the session's supervisor-op
// handler, ProcessFiles over SqliteVFS. Each case runs in two identical
// sessions, once through the binding and once on the process's own bridge,
// and the two outcomes must be the same.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { supervisorFilesystem } from '../../packages/core/src/runtime/vfs-supervisor.ts';
import { createSupervisorBridgeStore } from '../../packages/core/src/workspace/supervisor-op.ts';
import { supervisorDeliveryProps } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { SupervisorRPC, createRpcSession, supervisorRpcEnv } from './lib/supervisor-rpc-session.mjs';

/** A session with a home holding a file, a directory and a link to each, and one process in it. */
function session() {
  const harness = createSqliteVfsTestHarness();
  const kernel = new SqliteVFS(harness.sql, harness.ctx).as(CRED_KERNEL);
  kernel.mkdir('home/user/d', { recursive: true, mode: 0o755 });
  kernel.writeFile('home/user/f.txt', 'hello world');
  kernel.writeFile('home/user/d/a', 'a');
  kernel.symlink('f.txt', 'home/user/link');
  kernel.symlink('d', 'home/user/dlink');
  for (const path of ['home/user', 'home/user/d', 'home/user/d/a', 'home/user/f.txt']) kernel.chown(path, 1000, 1000);
  for (const path of ['home/user/link', 'home/user/dlink']) kernel.chown(path, 1000, 1000, { followSymlinks: false });
  return { harness, rpc: createRpcSession(new SqliteVFS(harness.sql, harness.ctx)) };
}

/** The process's filesystem through its SUPERVISOR binding, as a facet holds it. */
function remote() {
  const { rpc } = session();
  const pid = rpc.processes.spawn('python3', ['python3'], '/home/user').pid;
  const { hostIncarnation } = supervisorDeliveryProps(rpc.ctx);
  const env = supervisorRpcEnv((envelope) => rpc.host.supervisorOp(envelope));
  return supervisorFilesystem(new SupervisorRPC({ props: { doId: 'session', pid, writerId: 'writer-1', hostIncarnation } }, env));
}

/** The same process's filesystem as the session serves it. */
function local() {
  const { harness, rpc } = session();
  const pid = rpc.processes.spawn('python3', ['python3'], '/home/user').pid;
  return createSupervisorBridgeStore({ vfs: new SqliteVFS(harness.sql, harness.ctx), processes: rpc.processes }).bridge(pid);
}

const text = (bytes) => (bytes == null ? bytes : new TextDecoder().decode(bytes));
const statOf = async (fs, path) => {
  const stat = await fs.stat(path, { followSymlinks: false });
  return stat && { type: stat.type, size: stat.size, mode: stat.mode & 0o7777 };
};
async function outcome(run) {
  try {
    return { value: await run() };
  } catch (error) {
    return { code: error?.code ?? String(error) };
  }
}

const cases = {
  'a write that makes its parents': async (fs) => [await outcome(() => fs.writeFile('/home/user/made/deep/a.txt', 'x', { createParents: true }).then(() => 'written')), await statOf(fs, '/home/user/made/deep/a.txt')],
  'a write under a mask of its own': async (fs) => [await outcome(() => fs.writeFile('/home/user/masked.txt', 'x', { umask: 0o077 }).then(() => 'written')), await statOf(fs, '/home/user/masked.txt')],
  'a write of a revision the file is not at': async (fs) => [await outcome(() => fs.writeFile('/home/user/f.txt', 'x', { expectedRevision: 999_999 }).then(() => 'written')), await statOf(fs, '/home/user/f.txt')],
  'a read that does not follow a link': async (fs) => outcome(async () => text(await fs.readFile('/home/user/link', { followSymlinks: false }))),
  'a read of at most so many bytes': async (fs) => outcome(async () => text(await fs.readFile('/home/user/f.txt', { maxBytes: 4 }))),
  'a read of a content key the file does not have': async (fs) => outcome(async () => text(await fs.readFile('/home/user/f.txt', { contentKey: 'not-this-file' }))),
  'a range read of a revision the file is not at': async (fs) => outcome(async () => text(await fs.readRange('/home/user/f.txt', 0, 5, { expectedRevision: 999_999, expectedEpoch: 'not-this-epoch' }))),
  'a range write that makes its parents': async (fs) => [await outcome(() => fs.writeRange('/home/user/ranged/deep/b.txt', 0, new TextEncoder().encode('ab'), { createParents: true }).then(() => 'written')), await statOf(fs, '/home/user/ranged/deep/b.txt')],
  'a range write of a revision the file is not at': async (fs) => [await outcome(() => fs.writeRange('/home/user/f.txt', 0, new TextEncoder().encode('HE'), { expectedRevision: 999_999 }).then(() => 'written')), text(await fs.readFile('/home/user/f.txt'))],
  'a truncate that does not follow a link': async (fs) => [await outcome(() => fs.truncate('/home/user/link', 2, { followSymlinks: false }).then(() => 'truncated')), await statOf(fs, '/home/user/f.txt')],
  'a listing that does not follow a link': async (fs) => outcome(async () => (await fs.readdir('/home/user/dlink', { followSymlinks: false })).map((entry) => entry.name)),
  'a listing without revisions, content keys or link targets': async (fs) => outcome(async () => {
    const page = await fs.list(null, 100, { revisions: false, contentKeys: false, linkTargets: false });
    return page.entries.filter((entry) => entry.path.startsWith('home/user')).map((entry) => ({
      path: entry.path, contentKey: entry.contentKey !== undefined, linkTarget: entry.linkTarget !== undefined,
    }));
  }),
};

const differs = [];
for (const [name, run] of Object.entries(cases)) {
  const served = await run(local());
  const carried = await run(remote());
  try {
    assert.deepEqual(carried, served);
    console.log(`  ✓ ${name}: ${JSON.stringify(served)}`);
  } catch {
    differs.push(name);
    console.log(`  ✗ ${name}: through the binding ${JSON.stringify(carried)}, served ${JSON.stringify(served)}`);
  }
}
assert.deepEqual(differs, [], 'every option crosses the binding');
console.log('supervisor-rpc-options: ok');
