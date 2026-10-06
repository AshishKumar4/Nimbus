#!/usr/bin/env bun
/**
 * wasi-resident-fs-watchdog — a WASI guest's filesystem answers are brought up
 * to date after input reaches it, and the park watchdog's wake is such input.
 *
 * The real WASI body (WASI_INSTANCE_PREAMBLE_SRC) with a credential, so the
 * guest's calls are answered from its resident store, over a supervisor that
 * dispatches every op as the session does. The guest's imports are called
 * from here as a guest would call them:
 *   - a stat answered from the store does not see a peer's write: nothing
 *     reached the guest that could have told it;
 *   - a poll whose clock outlasts the watchdog is woken by the watchdog with
 *     EAGAIN after __WASI_PARK_DEADLINE_MS (10 s): time passed, and the next
 *     stat takes the barrier and sees the write.
 */

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WASI_INSTANCE_PREAMBLE_SRC } from '../../packages/core/src/runtime/wasi-instance.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { FILESYSTEM_RPC_METHODS } from '../../packages/core/src/runtime/vfs-supervisor.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SessionProcessSupervisor } from '../../packages/core/src/runtime/session-process-supervisor.ts';
import { createSupervisorBridgeStore, createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
import { makeImportsWithoutJSPI } from './lib/wasi-imports.mjs';
import { acrossRpc } from './lib/rpc-error.mjs';

if (typeof WebAssembly.Suspending !== 'function' || typeof WebAssembly.promising !== 'function') {
  console.log('wasi-resident-fs-watchdog: SKIPPED (this engine has no JSPI, so a guest answers from the session)');
  process.exit(0);
}

const modulePath = path.join(os.tmpdir(), `wasi-watchdog-${process.pid}.mjs`);
writeFileSync(modulePath, `${WASI_INSTANCE_PREAMBLE_SRC}\nexport { __wasiInitFS, __wasiMakeImports, __wasiAdoptSupervisor, __wasiFsStats };`);
let P;
try { P = await import(pathToFileURL(modulePath).href); } finally { rmSync(modulePath, { force: true }); }

const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const kernel = raw.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
kernel.chown('home/user', user.uid, user.gid);
kernel.writeFile('home/user/w.txt', 'one', { mode: 0o644 });
const processes = new SessionProcessSupervisor();
const { pid } = processes.spawn('guest', ['guest'], '/home/user', { cred: user });
const authority = new ProcessFiles(raw);
const bridge = createSupervisorBridgeStore({ vfs: raw, processes, filesystem: authority });
const dispatch = createSupervisorOpHandler({ vfs: raw, filesystem: authority, processes, bridge, host: {} });
const process_ = authority.bind({ pid, cred: user });
const supervisor = { synchronous: () => { throw new Error('rpc stubs have no synchronous view'); } };
for (const op of Object.values(FILESYSTEM_RPC_METHODS)) {
  supervisor[op] = async (...args) => {
    try { return await dispatch({ op, args, pid }); } catch (error) { throw acrossRpc(error); }
  };
}
// What session/rpc.ts answers itself rather than through the op table: the
// change feed (fsAcquire, fsList) and the batched read.
supervisor.fsAcquire = async (...args) => process_.acquire(...args);
supervisor.fsList = async (...args) => process_.list(...args);
supervisor.fsReadBatch = async (requests) => {
  const out = [];
  for (const request of requests) {
    try {
      if (!('length' in request)) out.push({ stat: (await process_.stat(request.path, { followSymlinks: false })) ?? null });
      else out.push({ bytes: await process_.readRange(request.path, request.offset, request.length) });
    } catch (error) { out.push({ error }); }
  }
  return out;
};

const memory = new WebAssembly.Memory({ initial: 4 });
P.__wasiInitFS({ root: '', preopens: [{ wasiPath: '/', vfsPath: '' }], cred: user });
P.__wasiAdoptSupervisor(supervisor);
const { wasiImport } = makeImportsWithoutJSPI(P, {
  argv: ['guest'], env: {}, getMemory: () => memory, stdoutWrite: () => {}, stderrWrite: () => {},
});
const view = () => new DataView(memory.buffer);
const PREOPEN_FD = 3;
const PATH = 1024;
const STAT_OUT = 2048;

/** path_filestat_get as the guest calls it: the size it sees, after the call parks if it does. */
async function guestStatSize(name) {
  const bytes = new TextEncoder().encode(name);
  new Uint8Array(memory.buffer).set(bytes, PATH);
  const errno = await wasiImport.path_filestat_get(PREOPEN_FD, 1, PATH, bytes.length, STAT_OUT);
  assert.equal(errno, 0, `stat ${name}: errno ${errno}`);
  return Number(view().getBigUint64(STAT_OUT + 32, true));
}

/** poll_oneoff with one relative clock subscription of `ms`: the errno the guest is handed. */
function guestSleep(ms) {
  const SUB = 4096, EVENT = 4096 + 48, NEVENTS = 4096 + 48 + 32;
  const v = view();
  v.setBigUint64(SUB, 1n, true);            // userdata
  v.setUint8(SUB + 8, 0);                    // tag: clock
  v.setUint32(SUB + 16, 1, true);            // clock id: monotonic
  v.setBigUint64(SUB + 24, BigInt(ms) * 1_000_000n, true); // timeout (ns)
  v.setBigUint64(SUB + 32, 0n, true);        // precision
  v.setUint16(SUB + 40, 0, true);            // flags: relative
  return wasiImport.poll_oneoff(SUB, EVENT, 1, NEVENTS);
}

// The store boots on the first call; the call after it is answered from it.
assert.equal(await guestStatSize('home/user/w.txt'), 3);
for (let i = 0; i < 20 && P.__wasiFsStats()?.local === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 10));
  await guestStatSize('home/user/w.txt');
}
assert.ok(P.__wasiFsStats().local > 0, "the store answers the guest");

kernel.writeFile('home/user/w.txt', 'three!', { mode: 0o644 });
assert.equal(await guestStatSize('home/user/w.txt'), 3, 'no input reached the guest: it reads what it read');

const started = Date.now();
const woke = await guestSleep(15_000);
const waited = Date.now() - started;
assert.ok(waited < 14_000, `the watchdog woke the guest (after ${waited} ms)`);
assert.equal(woke, 6 /* __WASI_EAGAIN */, 'with EAGAIN');
const barriers = P.__wasiFsStats().barriers;
assert.equal(await guestStatSize('home/user/w.txt'), 6, 'the wake was input: the next answer took the barrier');
assert.equal(P.__wasiFsStats().barriers, barriers + 1);

await bridge.dispose();
await authority.releaseProcess(pid);
harness.db.close();
console.log(`wasi-resident-fs-watchdog: the watchdog's wake after ${waited} ms took the barrier before the next answer`);
process.exit(0);
