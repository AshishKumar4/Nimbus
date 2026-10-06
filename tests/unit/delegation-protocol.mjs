#!/usr/bin/env bun
/**
 * Delegations through the supervisor (P3, the session's half): a process
 * is granted a subtree (fsAcquireExclusiveMutation with `delegate`), waits
 * for recalls (fsAwaitRecall, a long poll), sends what it decided under its
 * lease, and answers (fsRecalled). Another caller's access waits for that
 * answer. A holder that does not answer within the recall timeout is
 * revoked: the caller goes on, the host is told to stop the holder, and
 * every write the holder sends after is ESTALE. A delegation ends with its
 * process.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { withRecall } from '../../packages/core/src/vfs/recall.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';

const dec = new TextDecoder();
const user = { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 };

function session({ recallTimeoutMs = 2_000 } = {}) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user/repo', { recursive: true });
  kernel.chown('home/user', 1000, 1000);
  kernel.chown('home/user/repo', 1000, 1000);
  kernel.writeFile('home/user/repo/a', 'stored');
  const revoked = [];
  const filesystem = new ProcessFiles(engine, { delegationRecallTimeoutMs: recallTimeoutMs, delegationRevoked: (event) => revoked.push(event) });
  const pid = 4242;
  const lease = filesystem.bind({ pid, cred: user });
  const op = createSupervisorOpHandler({ vfs: engine, filesystem });
  return { engine, kernel, filesystem, op, pid, lease, revoked };
}

/**
 * A holder: decides writes into `decided` and, answering each recall, sends
 * them under its lease, then says so. `answers: false` never answers.
 */
async function holder({ op, pid }, root, { answers = true } = {}) {
  const grant = await op({ op: 'fsAcquireExclusiveMutation', args: [root, { delegate: { reads: true } }], pid });
  const decided = new Map();
  const recalls = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const kind = await op({ op: 'fsAwaitRecall', args: [grant.owner, 200], pid }).catch(() => null);
      if (kind === null) continue;
      recalls.push(kind);
      if (!answers) continue;
      // What it decided, as one wave under its lease, in the order it decided it.
      if (decided.size > 0) {
        const ops = [...decided].map(([path, text]) => {
          const data = new TextEncoder().encode(text);
          const at = path.replace(/^\//, '');
          return { type: 'file', inode: { path: at, parentPath: at.slice(0, at.lastIndexOf('/')), kind: 'file', isDir: false, size: data.length, mtime: 1, mode: 0o644, chunkCount: 1 }, data };
        });
        const result = await op({ op: 'writeBatchStream', args: [], stream: encodeWriteBatchStream({ inodes: [], chunks: [], ops }), pid, mutationOwner: grant.owner });
        assert.equal(result.ok, true, JSON.stringify(result.error));
      }
      decided.clear();
      await op({ op: 'fsRecalled', args: [grant.owner, kind], pid });
      if (kind === 'revoke') running = false;
    }
  })();
  return { grant, decided, recalls, stop: async () => { running = false; await loop; } };
}

// ── A foreign read waits for the holder to share; a foreign write, to give up ──
{
  const s = session();
  const h = await holder(s, '/home/user/repo');
  assert.equal(h.grant.root, 'home/user/repo');
  h.decided.set('/home/user/repo/b', 'decided by the holder');
  // The session's own read (a namespace call that can wait).
  const read = await withRecall(() => s.kernel.readFileString('home/user/repo/b'));
  assert.equal(read, 'decided by the holder');
  assert.deepEqual(h.recalls, ['share']);
  // A foreign write: the holder gives the subtree up.
  await withRecall(() => s.kernel.writeFile('home/user/repo/a', 'foreign'));
  assert.deepEqual(h.recalls, ['share', 'revoke']);
  assert.equal(dec.decode(s.kernel.readFile('home/user/repo/a')), 'foreign');
  // Given up: the holder's lease is gone, so its writes under it are refused.
  await assert.rejects(s.op({ op: 'fsWriteRange', args: ['/home/user/repo/late', 0, new Uint8Array([120])], pid: s.pid, mutationOwner: h.grant.owner }), /ESTALE/);
  await h.stop();
  assert.deepEqual(s.revoked, []);
}

// ── A holder that does not answer is revoked after the recall timeout: the
//    caller goes on, the host is told, and the holder's writes are ESTALE ──
{
  const s = session({ recallTimeoutMs: 150 });
  const h = await holder(s, '/home/user/repo', { answers: false });
  h.decided.set('/home/user/repo/b', 'never sent');
  const started = performance.now();
  const read = await withRecall(() => s.kernel.readFileString('home/user/repo/a'));
  const waited = performance.now() - started;
  assert.equal(read, 'stored');
  assert.ok(waited >= 140 && waited < 1_500, `the caller waited ${waited} ms for a holder with a 150 ms recall timeout`);
  assert.equal(s.revoked.length, 1);
  assert.deepEqual({ pid: s.revoked[0].pid, root: s.revoked[0].root, kind: s.revoked[0].kind }, { pid: s.pid, root: 'home/user/repo', kind: 'share' });
  await assert.rejects(s.op({ op: 'fsWriteRange', args: ['/home/user/repo/b', 0, new Uint8Array([120])], pid: s.pid, mutationOwner: h.grant.owner }), /ESTALE/);
  assert.equal(s.kernel.exists('home/user/repo/b'), false, "a revoked holder's write landed");
  await h.stop();
}

// ── A delegation ends with its process: what it never sent is lost, and the
//    subtree is free ──
{
  const s = session();
  const h = await holder(s, '/home/user/repo');
  h.decided.set('/home/user/repo/b', 'unobserved');
  await h.stop();
  s.filesystem.killProcess(s.pid);
  assert.equal(s.filesystem.delegations.size, 0);
  s.kernel.writeFile('home/user/repo/a', 'free');
  assert.equal(dec.decode(s.kernel.readFile('home/user/repo/a')), 'free');
  assert.equal(s.kernel.exists('home/user/repo/b'), false);
}

// ── The holder's own calls into its delegation (not sent in a wave) go
//    through, and recall nothing: it decides there ──
{
  const s = session();
  const h = await holder(s, '/home/user/repo');
  await s.op({ op: 'writeFile', args: ['/home/user/repo/direct', 'by the holder, directly'], pid: s.pid });
  assert.equal(new TextDecoder().decode(await s.op({ op: 'readFileBytes', args: ['/home/user/repo/direct'], pid: s.pid })), 'by the holder, directly');
  assert.deepEqual(h.recalls, [], "the holder's own call recalled its delegation");
  await h.stop();
}

// ── Only the holder answers for its delegation ──
{
  const s = session();
  const h = await holder(s, '/home/user/repo');
  s.filesystem.bind({ pid: 7, cred: user });
  await assert.rejects(s.op({ op: 'fsAwaitRecall', args: [h.grant.owner, 0], pid: 7 }), /ESTALE/);
  await assert.rejects(s.op({ op: 'fsRecalled', args: [h.grant.owner, 'share'], pid: 7 }), /ESTALE/);
  await h.stop();
}

console.log('delegation protocol: ok');
