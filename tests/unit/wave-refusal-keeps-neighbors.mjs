#!/usr/bin/env bun
// A wave that a refusal ends keeps what it committed before the refused op,
// whatever state that op left behind in the attempt the refusal rolled
// back. Through a process's binding of the session (ProcessFiles over
// SqliteVFS, the real wave ingest), each case is a wave of calls through an
// open description, then an unlink of a name not there (refused, ENOENT):
// the calls before it commit (committedOps), the unlink is the wave's
// refusal, and the process reads through its description what those calls
// made, and writes through it again. The descriptions' file is one a peer
// unlinked (its inode lives while a description holds it, as on Linux),
// and in one case still named.
//   - a write past the end (a hole), then a chmod of another file the
//     refusal did not reach, sent again (resident-fs-model seed 190);
//   - a write of a file larger than a chunk (its manifest);
//   - an append;
//   - an ftruncate that grows it, and one that shrinks it (a path call, it
//     commits alone, before the refused one: never retried);
//   - a write to a file still named;
//   - two calls before the refusal, read through the other description too;
//   - a write staged in pieces (past half a transaction's bytes);
//   - a refused write through a description not open (EBADF), the write
//     before it kept;
//   - after a restart, an append through a description the session kept
//     for its process (adopted again by the attempt the refusal rolled back);
//   - a write beneath a shared root, then a rename of the root the store
//     refuses (ENOSPC): the root stays shared, what is made in it later
//     made with its group-sharing mode.
//
// Red before: the rollback restored a detached file's description to the
// same object the rolled-back write had edited in place, so the retry read
// a chunk or manifest the rollback had removed (EIO, nothing committed); it
// left the binding holding a description the attempt adopted, closed by the
// rollback, so the retry's append was refused EBADF; and it left the shared
// root unregistered by the refused rename, so a file made in it later was
// 0600, not 0660.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { processFiles } from './lib/process-bridge.mjs';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };
const enc = new TextEncoder();
const call = (c) => ({ type: 'call', call: c });
const C = 'home/user/other/c';
const MISSING = call({ call: 'unlink', path: 'home/user/other/nowhere' });

/** A session with c opened twice (D1 made it, both read and write it), unlinked by a peer unless `named`. */
async function opened({ named = false } = {}) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/other', { recursive: true });
  kernel.chown('home/user', 1000, 1000);
  kernel.chown('home/user/other', 1000, 1000);
  const proc = processFiles(engine).bind({ pid: 7, cred: user });
  const wave = (ops) => proc.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops }));
  const opens = await wave([
    call({ call: 'open', path: C, mode: 0o644, create: true, read: true, description: 'D1' }),
    call({ call: 'open', path: C, mode: 0o644, read: true, description: 'D2' }),
  ]);
  assert.equal(opens.ok, true, JSON.stringify(opens));
  const [first, handle] = opens.receipts.map((receipt) => receipt.handle);
  assert.equal(typeof handle, 'number', `D2's descriptor: ${JSON.stringify(opens.receipts)}`);
  if (!named) kernel.unlink(C);
  const through = (fd) => () => proc.read(fd, 0, proc.fstat(fd).size);
  return { kernel, wave, contents: through(handle), contentsOfD1: through(first) };
}

/** `ops` then the refused unlink: the ops commit, the unlink is the refusal. */
async function refusedAfter(wave, ops) {
  const result = await wave([...ops, MISSING]);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.errno, 'ENOENT', `the unlink is the wave's refusal: ${JSON.stringify(result.error)}`);
  assert.equal(result.committedOps, ops.length, `the ops before it committed: ${JSON.stringify(result)}`);
}

const failed = [];
async function check(name, run) {
  try {
    await run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.log(`  FAIL  ${name}: ${String(error?.message ?? error).split('\n').slice(0, 4).join(' | ')}`);
    failed.push(name);
  }
}

await check('a write past the end, then a chmod the refusal did not reach', async () => {
  const { kernel, wave, contents } = await opened();
  const made = await wave([call({ call: 'open', path: 'home/user/other/a', mode: 0o644, create: true, exclusive: true, description: 'D3' })]);
  assert.equal(made.ok, true, JSON.stringify(made));
  const chmod = { type: 'setattr', path: 'home/user/other/a', attrs: { mode: 0o600 } };
  const result = await wave([
    call({ call: 'write', path: C, description: 'D2', offset: 5, data: enc.encode('sr') }),
    call({ call: 'unlink', path: C }),
    chmod,
  ]);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.errno, 'ENOENT', `the unlink is the wave's refusal: ${JSON.stringify(result.error)}`);
  assert.equal(result.committedOps, 1, `the write before it committed: ${JSON.stringify(result)}`);
  assert.deepEqual([...contents()], [0, 0, 0, 0, 0, 0x73, 0x72], 'D2 reads the write');
  assert.equal(kernel.stat('home/user/other/a').mode & 0o777, 0o644, 'the chmod after the refusal is not applied');
  const resent = await wave([chmod]);
  assert.equal(resent.ok, true, JSON.stringify(resent));
  assert.equal(kernel.stat('home/user/other/a').mode & 0o777, 0o600, 'a is 0600');
});

await check('a write of a file larger than a chunk', async () => {
  const { wave, contents } = await opened();
  const data = new Uint8Array(150_000);
  for (let at = 0; at < data.length; at += 65_536) crypto.getRandomValues(data.subarray(at, Math.min(data.length, at + 65_536)));
  await refusedAfter(wave, [call({ call: 'write', path: C, description: 'D2', offset: 0, data })]);
  assert.deepEqual(contents(), data, 'D2 reads the write');
  const again = await wave([call({ call: 'write', path: C, description: 'D2', offset: 100_000, data: enc.encode('xyz') })]);
  assert.equal(again.ok, true, JSON.stringify(again));
  const expected = data.slice();
  expected.set(enc.encode('xyz'), 100_000);
  assert.deepEqual(contents(), expected, 'D2 reads the second write over the first');
});

await check('an ftruncate that grows it', async () => {
  const { wave, contents } = await opened();
  await refusedAfter(wave, [call({ call: 'ftruncate', path: C, description: 'D2', size: 9 })]);
  assert.deepEqual([...contents()], new Array(9).fill(0), 'D2 reads nine zeros');
  const again = await wave([call({ call: 'write', path: C, description: 'D2', offset: 9, data: enc.encode('z') })]);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.deepEqual([...contents()], [...new Array(9).fill(0), 0x7a], 'D2 reads the write after them');
});

await check('an ftruncate that shrinks it', async () => {
  const { wave, contents } = await opened();
  const written = await wave([call({ call: 'write', path: C, description: 'D2', offset: 0, data: enc.encode('abcdef') })]);
  assert.equal(written.ok, true, JSON.stringify(written));
  await refusedAfter(wave, [call({ call: 'ftruncate', path: C, description: 'D2', size: 3 })]);
  assert.equal(new TextDecoder().decode(contents()), 'abc', 'D2 reads the first three');
  const again = await wave([call({ call: 'append', path: C, description: 'D2', data: enc.encode('Z') })]);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(new TextDecoder().decode(contents()), 'abcZ', 'D2 appends at its end');
});

await check('an append', async () => {
  const { wave, contents } = await opened();
  await refusedAfter(wave, [call({ call: 'append', path: C, description: 'D2', data: enc.encode('xy') })]);
  const again = await wave([call({ call: 'append', path: C, description: 'D2', data: enc.encode('zw') })]);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(new TextDecoder().decode(contents()), 'xyzw', 'D2 reads both appends, in order');
});

await check('a write to a file still named', async () => {
  const { kernel, wave, contents } = await opened({ named: true });
  await refusedAfter(wave, [call({ call: 'write', path: C, description: 'D2', offset: 5, data: enc.encode('sr') })]);
  assert.deepEqual([...contents()], [0, 0, 0, 0, 0, 0x73, 0x72], 'D2 reads the write');
  assert.deepEqual([...kernel.readFile(C)], [0, 0, 0, 0, 0, 0x73, 0x72], 'c holds it');
});

await check('two calls before the refusal, read through the other description too', async () => {
  const { wave, contents, contentsOfD1 } = await opened();
  await refusedAfter(wave, [
    call({ call: 'write', path: C, description: 'D2', offset: 0, data: enc.encode('ab') }),
    call({ call: 'append', path: C, description: 'D1', data: enc.encode('cd') }),
  ]);
  assert.equal(new TextDecoder().decode(contents()), 'abcd', 'D2 reads both');
  assert.equal(new TextDecoder().decode(contentsOfD1()), 'abcd', 'D1 reads both');
});

await check('a write staged in pieces', async () => {
  const { wave, contents } = await opened();
  const data = new Uint8Array(768 * 1024);
  for (let at = 0; at < data.length; at += 65_536) crypto.getRandomValues(data.subarray(at, at + 65_536));
  await refusedAfter(wave, [call({ call: 'write', path: C, description: 'D2', offset: 0, data })]);
  assert.deepEqual(contents(), data, 'D2 reads the write');
});

await check('a refused write through a description not open, the write before it kept', async () => {
  const { wave, contents } = await opened();
  const result = await wave([
    call({ call: 'write', path: C, description: 'D2', offset: 0, data: enc.encode('kept') }),
    call({ call: 'write', path: C, description: 'D9', offset: 0, data: enc.encode('never') }),
  ]);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.errno, 'EBADF', `the second write is the refusal: ${JSON.stringify(result.error)}`);
  assert.equal(result.committedOps, 1, `the first committed: ${JSON.stringify(result)}`);
  assert.equal(new TextDecoder().decode(contents()), 'kept', 'D2 reads the first write');
});

await check('after a restart, an append through a description the session kept', async () => {
  const harness = createSqliteVfsTestHarness();
  const first = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = first.as(CRED_KERNEL);
  kernel.mkdir('home/user/other', { recursive: true });
  kernel.chown('home/user', 1000, 1000);
  kernel.chown('home/user/other', 1000, 1000);
  const sequenced = (proc, first, ack, ops) => proc.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops }), { sequence: { writer: '7:w', first, ack, pid: 7 } });
  const before = processFiles(first).bind({ pid: 7, cred: user });
  const open = await sequenced(before, 1, 0, [call({ call: 'open', path: C, mode: 0o644, create: true, read: true, description: 'K' })]);
  assert.equal(open.ok, true, JSON.stringify(open));
  // The session restarts: a new engine and binding over the same store, the description kept for process 7.
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const after = new ProcessFiles(engine).bind({ pid: 7, cred: user });
  const result = await sequenced(after, 2, 1, [call({ call: 'append', path: C, description: 'K', data: enc.encode('xy') }), MISSING]);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.errno, 'ENOENT', `the unlink is the wave's refusal: ${JSON.stringify(result.error)}`);
  assert.equal(result.committedOps, 1, `the append committed: ${JSON.stringify(result)}`);
  assert.equal(new TextDecoder().decode(engine.as(CRED_KERNEL).readFile(C)), 'xy', 'c holds the append');
  const again = await sequenced(after, 4, 3, [call({ call: 'append', path: C, description: 'K', data: enc.encode('zw') })]);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(new TextDecoder().decode(engine.as(CRED_KERNEL).readFile(C)), 'xyzw', 'c holds both appends');
});

await check('a write beneath a shared root, then a rename of the root the store refuses', async () => {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  const member = { uid: 2000, gid: 2000, groups: [2000, 1000], umask: 0o022 };
  kernel.mkdir('proj/team', { recursive: true });
  kernel.chown('proj', 2000, 2000);
  kernel.chown('proj/team', 0, 1000);
  kernel.chmod('proj/team', 0o2775);
  kernel.setDefaultAcl('proj/team', 0o775);
  engine.registerSharedDirectory('proj/team');
  const proc = processFiles(engine).bind({ pid: 7, cred: member });
  const wave = (ops) => proc.writeStream(encodeWriteBatchStream({ inodes: [], chunks: [], ops }));
  // The store refuses the rename's first write of its new name, once.
  let armed = true;
  harness.setFaultInjector((statement) => {
    const writes = statement.transaction !== null && /^\s*(INSERT|UPDATE|DELETE)/i.test(statement.sql);
    if (!armed || !writes || !statement.params.some((param) => typeof param === 'string' && param.startsWith('proj/team2'))) return null;
    armed = false;
    return Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  });
  const result = await wave([
    call({ call: 'writeFile', path: 'proj/team/x', mode: 0o600, data: enc.encode('x') }),
    { type: 'rename', from: 'proj/team', to: 'proj/team2' },
  ]);
  harness.clearFault();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.errno, 'ENOSPC', `the rename is the wave's refusal: ${JSON.stringify(result.error)}`);
  assert.equal(result.committedOps, 1, `the write committed: ${JSON.stringify(result)}`);
  assert.equal(kernel.stat('proj/team/x').mode & 0o7777, 0o660, 'x has the shared root\'s group mode');
  const later = await wave([call({ call: 'writeFile', path: 'proj/team/y', mode: 0o600, data: enc.encode('y') })]);
  assert.equal(later.ok, true, JSON.stringify(later));
  assert.equal(kernel.stat('proj/team/y').mode & 0o7777, 0o660, 'the root is still shared');
});

assert.deepEqual(failed, [], 'every case keeps what its wave committed');
console.log('wave-refusal-keeps-neighbors: ok');
