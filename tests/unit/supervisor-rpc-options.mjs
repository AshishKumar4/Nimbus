#!/usr/bin/env bun
// The bridge over a supervisor (a facet's filesystem: core
// supervisorFilesystem over the SupervisorRPC binding) answers every call as
// the bridge the session serves it from does, the call's options included:
// a write that makes its parents, a write's mask, a write or read that names
// the revision it is of, a read of at most so many bytes, a listing that
// leaves out what it was not asked for.
//
// Real code on both sides: SupervisorRPC, the session's supervisor-op
// handler, ProcessFiles over SqliteVFS. Each case runs in two identical
// sessions, once through the binding and once on the process's own bridge,
// and the two outcomes must be the same.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { supervisorFilesystem } from '../../packages/core/src/runtime/vfs-supervisor.ts';
import { createSupervisorBridgeStore, createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { supervisorDeliveryProps } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { SupervisorRPC, createRpcSession, supervisorRpcEnv } from './lib/supervisor-rpc-session.mjs';
import { _rpcFsList } from '../../packages/worker/src/session/rpc.ts';

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
  const rpc = createRpcSession(new SqliteVFS(harness.sql, harness.ctx));
  // The session's own RPC body a listing is routed to (NimbusSession._rpcFsList).
  rpc.host._rpcFsList = (after, limit, options, pid) => _rpcFsList(rpc.host, after, limit, options, pid);
  return { harness, rpc };
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
  'a write that makes its parents': async (fs) => [await outcome(async () => { await fs.writeFile('/home/user/made/deep/a.txt', 'x', { createParents: true }); return 'written'; }), await statOf(fs, '/home/user/made/deep/a.txt')],
  'a write under a mask of its own': async (fs) => [await outcome(async () => { await fs.writeFile('/home/user/masked.txt', 'x', { umask: 0o077 }); return 'written'; }), await statOf(fs, '/home/user/masked.txt')],
  'a write of a revision the file is not at': async (fs) => [await outcome(async () => { await fs.writeFile('/home/user/f.txt', 'x', { expectedRevision: 999_999 }); return 'written'; }), await statOf(fs, '/home/user/f.txt')],
  'a read of at most so many bytes': async (fs) => outcome(async () => text(await fs.readFile('/home/user/f.txt', { maxBytes: 4 }))),
  'a read of a content key the file does not have': async (fs) => outcome(async () => text(await fs.readFile('/home/user/f.txt', { contentKey: 'not-this-file' }))),
  'a range read of a revision the file is not at': async (fs) => outcome(async () => text(await fs.readRange('/home/user/f.txt', 0, 5, { expectedRevision: 999_999, expectedEpoch: 'not-this-epoch' }))),
  'a range write that makes its parents': async (fs) => [await outcome(async () => { await fs.writeRange('/home/user/ranged/deep/b.txt', 0, new TextEncoder().encode('ab'), { createParents: true }); return 'written'; }), await statOf(fs, '/home/user/ranged/deep/b.txt')],
  'a range write of a revision the file is not at': async (fs) => [await outcome(async () => { await fs.writeRange('/home/user/f.txt', 0, new TextEncoder().encode('HE'), { expectedRevision: 999_999 }); return 'written'; }), text(await fs.readFile('/home/user/f.txt'))],
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

// A read's lease is sized by the file whose bytes it returns: a read of a
// link returns its target's, whatever the read's options say of following.
{
  const { harness } = session();
  const vfs = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = vfs.as(CRED_KERNEL);
  kernel.writeFile('home/user/big.bin', new Uint8Array(100_000));
  kernel.symlink('big.bin', 'home/user/biglink');
  const leases = [];
  const filesystem = new ProcessFiles(vfs);
  const op = createSupervisorOpHandler({ vfs, filesystem, readLease: (bytes, read) => { leases.push(bytes); return read(); } });
  filesystem.bind({ pid: 77, cred: CRED_KERNEL });
  const whole = await op({ op: 'readFileBytes', args: ['/home/user/biglink', { followSymlinks: false }], pid: 77 });
  const range = await op({ op: 'fsReadRange', args: ['/home/user/biglink', 50_000, 40_000, { followSymlinks: false }], pid: 77 });
  assert.deepEqual([whole.byteLength, range.byteLength], [100_000, 40_000], 'both read the target');
  assert.deepEqual(leases, [100_000, 40_000], 'and each was leased for what it read');
  console.log('  ✓ a read of a link is leased for the target it reads');
}
console.log('supervisor-rpc-options: ok');
