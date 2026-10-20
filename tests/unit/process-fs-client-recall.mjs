#!/usr/bin/env bun
/**
 * process-fs-client-recall — a wave the session refuses while it recalls a
 * delegation goes again once the recall is over, and only that refusal:
 *
 * - one marked `recall` (the session met RecallRequired, kept no refusal)
 *   is sent again, its writes not lost, for as long as a recall may take;
 * - a refusal the session kept answers its op, whatever its errno (EAGAIN
 *   from a backend's close included), and is never sent again as a success;
 * - an unfenced wave refused EAGAIN with no `recall` is lost (EIO), as before;
 * - each head of the log has its own budget: many in a row, each refused
 *   once, all land;
 * - a close that consumed its description and then met a recall (its
 *   backend's flush) took effect: the session does not mark it to go again,
 *   and the client answers it as failed, fenced or not, never as done.
 */

import assert from 'node:assert/strict';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SupervisorDeliveries } from '../../packages/core/src/workspace/supervisor-delivery.ts';
import { createSupervisorOpHandler } from '../../packages/core/src/workspace/supervisor-op.ts';
import { processFsClient } from '../../packages/core/src/_shared/process-fs-client.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';
import { WaveIngest } from '../../packages/core/src/runtime/wave-ingest.ts';
import { RecallRequired } from '../../packages/core/src/vfs/recall.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const PID = 41;
const RETRY = { backoffMs: [1, 1, 1], stallMs: 2_000, answerDeadlineMs: 2_000 };

/** A session in process, each wave's answer through `refuse(fence)` first: an answer to give instead of delivering, or null to deliver. */
function session({ fenced = true } = {}) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const files = new ProcessFiles(engine);
  files.bind({ pid: PID, cred: CRED_SESSION_USER });
  const deliveries = new SupervisorDeliveries();
  const op = createSupervisorOpHandler({ vfs: engine, filesystem: files, deliveries });
  const s = {
    waves: 0,
    refuse: () => null,
    text: (key) => { try { return dec.decode(kernel.readFile(key)); } catch { return null; } },
    port: {
      openWriter: async () => (fenced ? deliveries.openWaveWriter(PID, 60_000) : null),
      retireWriter: async (writer) => { await op({ op: 'retireWaveWriter', args: [writer], pid: PID }); },
      writeBatchStream: async (stream, fence) => {
        s.waves++;
        const instead = s.refuse(fence);
        if (instead !== null) {
          await new Response(stream).arrayBuffer();
          return instead;
        }
        return op({ op: 'writeBatchStream', args: [], pid: PID, stream, ...(fence ? { waveFence: { ...fence, hostIncarnation: deliveries.incarnation } } : {}) });
      },
      grants: {
        acquire: (path, delegate) => op({ op: 'fsAcquireExclusiveMutation', args: [path, { delegate }], pid: PID }),
        release: (owner) => op({ op: 'fsReleaseExclusiveMutation', args: [owner], pid: PID }),
        awaitRecall: (owner, waitMs) => op({ op: 'fsAwaitRecall', args: [owner, waitMs], pid: PID }),
        recalled: (owner, kind) => op({ op: 'fsRecalled', args: [owner, kind], pid: PID }),
      },
    },
  };
  return s;
}

/** The session's answer to a wave it applied nothing of: `refused`, a kept refusal of its first op; `recall`, a delegation it recalls first. */
function nothingApplied(fence, { errno = 'EAGAIN', refused = false, recall = false } = {}) {
  const cursor = fence ? fence.seq - 1 : 0;
  const message = `${errno}: resource temporarily unavailable, route '/home/user'`;
  return {
    ok: false, committedGroupSequence: 0, committedPathCount: 0, committedOps: 0, inodes: 0, chunks: 0, receipts: [],
    ...(fence ? { sequence: { cursor, ...(refused ? { refused: { seq: fence.seq, errno, message } } : {}) } } : {}),
    error: { code: 'ERR_WRITE_BATCH_STREAM', phase: 'decode', message, errno, ...(recall ? { recall: true } : {}) },
  };
}

const client = (s) => processFsClient({ session: s.port, retry: RETRY, grantAfter: Number.MAX_SAFE_INTEGER });
const writeFile = (path, text) => ({ type: 'call', call: { call: 'writeFile', path, mode: 0o644, data: enc.encode(text) } });

// ── A recall refusal: the wave goes again, and its write lands ──
{
  const s = session();
  let refusals = 2;
  s.refuse = (fence) => (refusals-- > 0 ? nothingApplied(fence, { recall: true }) : null);
  const c = client(s);
  const answer = c.submit(writeFile('home/user/a.txt', 'kept'));
  await c.flush();
  assert.equal((await answer)?.failed, undefined, 'the write was not failed');
  assert.equal(s.text('home/user/a.txt'), 'kept');
  assert.equal(s.waves, 3, 'refused twice, applied the third time');
  await c.settle();
}

// ── A recall as long as the session allows one: the wave waits it out ──
{
  const s = session();
  const until = Date.now() + 3_000;
  s.refuse = (fence) => (Date.now() < until ? nothingApplied(fence, { recall: true }) : null);
  const c = client(s);
  const answer = c.submit(writeFile('home/user/slow.txt', 'kept'));
  await c.flush();
  assert.equal((await answer)?.failed, undefined, 'the write was not failed');
  assert.equal(s.text('home/user/slow.txt'), 'kept');
  await c.settle();
}

// ── A refusal the session kept, with EAGAIN (a backend's close): its op fails, and is not sent again ──
{
  const s = session();
  let refusals = 1;
  s.refuse = (fence) => (refusals-- > 0 ? nothingApplied(fence, { refused: true }) : null);
  const c = client(s);
  const answer = c.submit(writeFile('home/user/b.txt', 'refused')).then((value) => ({ value }), (error) => ({ error }));
  await c.flush().catch(() => undefined);
  const settled = await answer;
  assert.equal(settled.error?.code, 'EAGAIN', `the refused op is answered as the session refused it, not as a success: ${JSON.stringify(settled)}`);
  assert.equal(s.text('home/user/b.txt'), null, 'and nothing was written');
  assert.equal(s.waves, 1, 'not sent again');
  await c.settle().catch(() => undefined);
}

// ── Unfenced, EAGAIN with no recall: lost, as any unknown outcome ──
{
  const s = session({ fenced: false });
  let refusals = 1;
  s.refuse = (fence) => (refusals-- > 0 ? nothingApplied(fence) : null);
  const c = client(s);
  const answer = c.submit(writeFile('home/user/c.txt', 'unknown')).then((value) => ({ value }), (error) => ({ error }));
  await c.flush().catch(() => undefined);
  const settled = await answer;
  assert.equal(settled.error?.code, 'EIO', `an unknown outcome is no success: ${JSON.stringify(settled)}`);
  assert.equal(s.waves, 1, 'not sent again');
  await c.settle().catch(() => undefined);
}

// ── Each head its own budget: a wave of twelve, each answer applying one more op and refusing the rest for a recall, lands whole ──
{
  const s = session();
  const c = client(s);
  let answered = 0;
  const port = s.port.writeBatchStream;
  s.port.writeBatchStream = async (stream, fence) => {
    const answer = await port(stream, fence);
    if (answer.ok !== true || answered >= 11) return answer;
    // Applied (a re-sent op the session has is applied once); answered as one more op, the rest refused for a recall.
    answered++;
    const cursor = Math.min(answer.sequence.cursor, fence.seq);
    return { ...nothingApplied(fence, { recall: true }), sequence: { cursor } };
  };
  const answers = [];
  for (let i = 0; i < 12; i++) answers.push(c.submit(writeFile(`home/user/n${i}.txt`, `n${i}`)));
  await c.flush();
  for (const [i, answer] of answers.entries()) assert.equal((await answer)?.failed, undefined, `write ${i} was not failed`);
  for (let i = 0; i < 12; i++) assert.equal(s.text(`home/user/n${i}.txt`), `n${i}`);
  await c.settle();
}

// ── A close whose description is consumed, its flush then meeting a recall: failed, never done, fenced or not ──
for (const fenced of [true, false]) {
  const harness = createSqliteVfsTestHarness();
  const engine = new SqliteVFS(harness.sql, harness.ctx);
  const waves = new WaveIngest(null);
  const kernel = engine.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  kernel.writeFile('home/user/e.txt', enc.encode(''));
  kernel.chown('home/user/e.txt', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  const nodes = new Map();
  let failClose = true;
  // The binding's descriptions: its close takes the description, then its flush meets a delegation to recall.
  const descriptions = {
    adopt: (id, ino, rights, path, cred) => {
      const node = engine.describeInode(ino, path, cred, rights);
      if (node === null) return null;
      nodes.set(id, node);
      return 1;
    },
    node: (id) => nodes.get(id),
    mounted: () => undefined,
    handle: (id) => (nodes.has(id) ? 1 : undefined),
    close: (id) => {
      const node = nodes.get(id);
      if (node === undefined) return;
      nodes.delete(id);
      node.close();
      if (failClose) {
        failClose = false;
        throw Object.assign(new Error('EAGAIN: close: its buffered writes wait on a recall'), { code: 'EAGAIN', cause: new RecallRequired('home/user', 'revoke', 'home/user/e.txt', async () => {}) });
      }
    },
  };
  let epochs = 0;
  const user = engine.as(CRED_SESSION_USER);
  const c = processFsClient({
    session: {
      openWriter: async () => (fenced ? `w${++epochs}` : null),
      writeBatchStream: (stream, fence) => waves.writeStream(user, stream, {
        ...(fenced ? { sequence: { writer: `${PID}:${fence.writer}`, first: fence.seq, ack: fence.ack ?? 0, pid: PID } } : {}),
        descriptions,
      }),
    },
    retry: RETRY,
    grantAfter: Number.MAX_SAFE_INTEGER,
  });
  const label = fenced ? 'fenced' : 'unfenced';
  await c.submit({ type: 'call', call: { call: 'open', path: 'home/user/e.txt', mode: 0o644, access: 'write', description: 'e1' } });
  const closing = c.submit({ type: 'call', call: { call: 'close', path: 'home/user/e.txt', description: 'e1' } }).then((value) => ({ value }), (error) => ({ error }));
  await c.flush().catch(() => undefined);
  const closed = await closing;
  assert.notEqual(closed.error, undefined, `${label}: a close that took effect and failed is no success: ${JSON.stringify(closed)}`);
  await c.settle().catch(() => undefined);
}

console.log('process-fs-client-recall: ok');
