#!/usr/bin/env bun
// A namespace that stopped answering is a failure state, not a mode
// (CUTOVER #13, Main's rule):
//   - a synchronous stat, exists or readdir is refused with EAGAIN naming the
//     cause and the asynchronous form that answers now, and each refusal is
//     counted (namespaceRefusals in exec telemetry);
//   - the next async boundary the process reaches (here a timer's barrier)
//     repairs it, so the same call then answers.
// The failure is the real one: a directory became searchable, so the barrier
// relists it, and that relist fails.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { _rpcFsAcquire, _rpcFsList, _rpcFsReadBatch } from '../../packages/worker/src/session/rpc.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { processBridge } from './lib/process-bridge.mjs';
import { attachSupervisorOps } from './lib/session-supervisor-ops.mjs';
import { SHIMS_STORE_PRELUDE, listAuthority } from './lib/shims-namespace.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const kernel = rawVfs.as(CRED_KERNEL);
const CRED = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
kernel.mkdir('home/user/app', { recursive: true, mode: 0o755 });
for (const dir of ['home', 'home/user', 'home/user/app']) kernel.chown(dir, 1000, 1000);
// A directory the process cannot search yet, holding a file.
kernel.mkdir('home/user/app/locked', { mode: 0o700 });
kernel.writeFile('home/user/app/locked/inside.txt', new TextEncoder().encode('inside'));

const host = attachSupervisorOps({ sqliteFs: rawVfs, processes: new SessionProcessSupervisor(), ensureSqliteFs() {} });
const bridge = processBridge(rawVfs, rawVfs.as(CRED));
let listingFails = false;
const supervisor = {
  stat: (p) => bridge.stat(p),
  lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? new TextDecoder().decode(b) : null; },
  fsList: async (after, limit) => {
    if (listingFails) throw new Error('Network connection lost.');
    return _rpcFsList(host, after ?? null, limit ?? null);
  },
  fsReadBatch: (requests) => _rpcFsReadBatch(host, requests),
  fsAcquire: (epoch, cursor, options) => _rpcFsAcquire(host, epoch, cursor, options),
};

listAuthority(rawVfs);
globalThis.__nimbusVfsCursor = { epoch: rawVfs.epoch, rev: rawVfs.revision() };
const { fs, setTimeout: shimTimeout } = new Function(
  '__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode()
    + '\n;return { fs: __fsMod, setTimeout: globalThis.setTimeout };',
)({}, {}, supervisor, CRED, '/home/user/app', [], {}, '/home/user/app/main.js', '/home/user/app');
const stats = globalThis.__nimbusVfsCoherence;
const afterTimer = () => new Promise((resolve) => shimTimeout(resolve, 0));

assert.equal(fs.existsSync('/home/user/app'), true, 'the launch answers from its namespace');
const refusalsBefore = stats.namespaceRefusals;

// The directory becomes searchable; the barrier that reports it relists it,
// and that relist fails.
kernel.chmod('home/user/app/locked', 0o755);
listingFails = true;
await afterTimer();

let refused = null;
try { fs.statSync('/home/user/app/locked/inside.txt'); } catch (error) { refused = error; }
assert.ok(refused, 'a sync stat is refused while the namespace is not answering');
assert.equal(refused.code, 'EAGAIN');
assert.match(refused.message, /the namespace is being rebuilt after a listing of \/home\/user\/app\/locked failed \(Network connection lost\.\)/,
  `the refusal names its cause: ${refused.message}`);
assert.match(refused.message, /use fs\.promises\.stat/, 'and the asynchronous form that answers now');
assert.throws(() => fs.readdirSync('/home/user/app'), (e) => e.code === 'EAGAIN' && /fs\.promises\.readdir/.test(e.message));
assert.equal(stats.namespaceRefusals, refusalsBefore + 2, 'each refusal is counted');

// The next async boundary repairs it, and the same call answers.
listingFails = false;
const repairsBefore = stats.namespaceRepairs;
await afterTimer();
assert.equal(stats.namespaceRepairs, repairsBefore + 1, 'the boundary repaired the namespace');
assert.equal(fs.statSync('/home/user/app/locked/inside.txt').size, 6, 'the refused call now answers');
assert.deepEqual(fs.readdirSync('/home/user/app/locked'), ['inside.txt']);

console.log('namespace-failure-state: a failed relist refuses by name, is counted, and the next boundary repairs it');
