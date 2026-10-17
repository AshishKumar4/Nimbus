#!/usr/bin/env bun
// A call that spans turns runs each later turn as its caller, the
// delegations its process holds included. A process writing in a subtree it
// holds itself (a WASI process's grant) must not have that write taken for
// another's: the session would recall the process's own grant, wait for an
// answer the process cannot give while it waits on the write, and revoke it.
//   (1) a file written from a source that arrives over turns (writeFileFrom);
//   (2) a tree copied in slices (copyTree past one slice's rows);
//   (3) both, started behind a snapshot that quiesces: they begin later,
//       outside the call, and are still their caller's.
// Red before: each later turn ran without the caller's holds, and the
// process's own grant was revoked for not answering the recall its write made.

import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

/** A session, and its process 7 holding home/user/proj; `revoked` counts the grants it lost. */
function holding() {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/proj', { recursive: true });
  kernel.chown('home/user', 1000, 1000);
  kernel.chown('home/user/proj', 1000, 1000);
  const session = { engine, kernel, revoked: 0 };
  const files = new ProcessFiles(engine, { delegationRecallTimeoutMs: 300, delegationRevoked: () => { session.revoked++; } });
  session.files = files;
  session.proc = files.bind({ pid: 7, cred: user });
  session.grant = session.proc.acquireExclusiveMutation('/home/user/proj', { delegate: { reads: true, inos: 64, bytes: 1 << 26 } });
  return session;
}

// ── (1) a file from a source that arrives over turns ──
{
  const s = holding();
  const piece = new Uint8Array(65_536).fill(7);
  const pieces = 8;
  async function* source() {
    for (let i = 0; i < pieces; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      yield piece;
    }
  }
  assert.equal(await s.proc.writeFileFrom('/home/user/proj/big.bin', piece.byteLength * pieces, source()) > 0, true);
  assert.equal(s.revoked, 0, '(1) the process\'s own write recalled its grant');
  assert.equal(s.files.delegations.size, 1, '(1) the grant is still the process\'s');
  s.proc.releaseExclusiveMutation(s.grant.owner);
  assert.equal(s.kernel.stat('home/user/proj/big.bin').size, piece.byteLength * pieces);
}

// ── (2) a tree copied in slices ──
// A slice is 200 pages of 250 rows, so the source is one row more than a slice.
{
  const s = holding();
  s.kernel.mkdir('home/user/big', { recursive: true });
  for (let page = 0; page < 200; page++) s.kernel.mkdirBatch(Array.from({ length: 250 }, (_, i) => `home/user/big/d${page * 250 + i}`));
  s.kernel.chown('home/user/big', 1000, 1000);
  assert.ok(await s.proc.copyTree('/home/user/big', '/home/user/proj/copy') > 50_000);
  assert.equal(s.revoked, 0, '(2) the process\'s own copy recalled its grant');
  assert.equal(s.files.delegations.size, 1, '(2) the grant is still the process\'s');
  s.proc.releaseExclusiveMutation(s.grant.owner);
  assert.equal(s.kernel.exists('home/user/proj/copy/d49999'), true);
}

// ── (3) both, started behind a snapshot that quiesces ──
// Another's write over turns keeps the snapshot quiescing while the
// process's call is made: it waits for it and begins after, outside the
// call that made it. The snapshot shares the process's grant (the process
// answers, as its holder does); a change of the process's own needs no
// more. Red before: it took the holds that were active when it began,
// which were none, and so revoked the process's grant.
/** `call` made by `s`'s process while a snapshot quiesces behind another's write; its answer, and the recalls the process answered. */
async function behindSnapshot(s, call) {
  const kinds = [];
  const answering = (async () => {
    for (;;) {
      let kind;
      try { kind = await s.proc.awaitRecall(s.grant.owner, 20); } catch { return; }
      if (kind === null) continue;
      kinds.push(kind);
      await s.proc.recalled(s.grant.owner, kind);
      if (kind === 'revoke') return;
    }
  })();
  const go = Promise.withResolvers();
  async function* held() { await go.promise; yield new Uint8Array(70_000).fill(1); }
  const blocking = s.kernel.writeFileFrom('tmp-slow.bin', 70_000, held());
  const snapshot = s.engine.snapshot('quiet', { quiesce: true });
  const called = call();
  go.resolve();
  await blocking;
  await snapshot;
  const answer = await called;
  s.proc.releaseExclusiveMutation(s.grant.owner);
  await answering;
  return { answer, kinds };
}
{
  const s = holding();
  const piece = new Uint8Array(65_536).fill(3);
  async function* source() {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      yield piece;
    }
  }
  const { answer, kinds } = await behindSnapshot(s, () => s.proc.writeFileFrom('/home/user/proj/late.bin', piece.byteLength * 3, source()));
  assert.ok(answer > 0);
  assert.deepEqual(kinds, ['share'], '(3) a write started behind the snapshot recalled its process\'s own grant');
  assert.equal(s.revoked, 0);
  assert.equal(s.kernel.stat('home/user/proj/late.bin').size, piece.byteLength * 3);
}
{
  const s = holding();
  s.kernel.mkdir('home/user/small', { recursive: true });
  s.kernel.mkdirBatch(['home/user/small/x', 'home/user/small/y']);
  s.kernel.chown('home/user/small', 1000, 1000);
  const { answer, kinds } = await behindSnapshot(s, () => s.proc.copyTree('/home/user/small', '/home/user/proj/small'));
  assert.ok(answer > 0);
  assert.deepEqual(kinds, ['share'], '(3) a copy started behind the snapshot recalled its process\'s own grant');
  assert.equal(s.revoked, 0);
  assert.equal(s.kernel.exists('home/user/proj/small/y'), true);
}

console.log('ok - vfs-spanning-holds (a write over turns and a copy in slices stay their caller\'s, its holds included)');
