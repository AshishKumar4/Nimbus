import assert from 'node:assert/strict';
import { processFsClient } from '../../packages/core/src/_shared/process-fs-client.ts';
import { readDirectoryPool } from '../../packages/core/src/runtime/wasi/read-directory-pool.ts';
import { DIRECTORY_PREFETCH_LIMIT } from '../../packages/core/src/constants.ts';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  let clock = 1000, next = 0, cursor = { epoch: 'E', rev: 1 };
  const calls = [], held = new Map(), recalls = new Map(), nodes = new Map();
  const s = { calls, held, nodes, hook: null, admission: null, clock: (value) => { clock = value; } };
  for (let i = 0; i < 100; i++) nodes.set(`d${i}`, { type: 'directory', dev: 1, ino: i + 1, revision: 1, mode: 0o755, uid: 0, gid: 0, nlink: 1, size: 0, atime: 1, mtime: 1, ctime: 1, target: null });
  const recalled = deferred();
  const client = processFsClient({
    now: () => clock,
    session: {
      openWriter: async () => null, writeBatchStream: async () => { throw new Error('no writes expected'); },
      grants: {
        acquire: async () => null,
        release: async (owner) => { recalls.get(owner)?.(null); },
        awaitRecall: (owner) => new Promise((resolve) => { recalls.set(owner, resolve); }),
        recalled: async () => { recalled.resolve(); },
      },
    },
  });
  const pool = readDirectoryPool({
    ...options,
    client, before: async () => {},
    store: {
      ready: () => true, cursor: () => cursor, entry: (key) => nodes.get(key),
      async admit(answer) {
        if (s.admission) await s.admission(answer);
        cursor = { epoch: answer.epoch, rev: answer.rev };
        for (const change of answer.paths) if (change.stat) nodes.set(change.path, { ...change.stat, target: null });
        return !answer.poison;
      },
    },
    async call(request) {
      calls.push(request);
      for (const id of request.retire) held.delete(id);
      for (const id of request.claim) if (held.has(id)) held.get(id).claimed = true;
      for (const [id, item] of held) if (!item.claimed) held.delete(id);
      const opened = request.open.map((path) => {
        const key = String(path).replace(/^\//, '');
        const entry = nodes.get(key);
        if (!entry || entry.mode === 0) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        const handle = { id: ++next, path: key, position: 0, closed: false, flags: { read: true, write: false, directory: true } };
        held.set(handle.id, { claimed: false, handle });
        return { key, handle, dev: entry.dev, ino: entry.ino, opened: { mode: entry.mode, uid: entry.uid, gid: entry.gid, ctime: entry.ctime } };
      });
      const answer = { channel: request.channel, sequence: request.sequence, opened, retired: request.retire, claimed: request.claim,
        outstanding: held.size, acquire: { epoch: 'E', rev: cursor.rev, paths: [], poison: false, namespace: true,
          ...(request.lease ? { readLease: { owner: 'L' + request.sequence, trustMs: 500 } } : {}) } };
      return s.hook ? s.hook(request, answer) : answer;
    },
  });
  s.pool = pool;
  s.recall = async () => { for (const finish of recalls.values()) finish('revoke'); await recalled.promise; };
  // The run's end retires every description the pool accounts for: a shell's
  // commands share its pid and descriptor scope, which outlives the run.
  s.close = async () => {
    await pool.dispose();
    await client.settle();
    for (const finish of recalls.values()) finish(null);
    assert.equal(held.size, 0, 'the run left no description open');
    if (calls.length > 0) assert.equal(calls[calls.length - 1].end, true, 'and its last exchange ended the channel');
  };
  /** The ids the next exchange retires: what the pool still owes the session. */
  s.retiredNext = async () => {
    await pool.open('/d99', 'd99', async () => []);
    return calls[calls.length - 1].retire;
  };
  return s;
}

{
  const s = fixture();
  try {
    const a = await s.pool.open('/d0', 'd0', async () => ['/d1', '/d2']);
    const b = await s.pool.open('/d1', 'd1', async () => { throw new Error('a warm prefetch performs no planning I/O'); });
    assert.equal(s.calls.length, 1);
    assert.equal(s.pool.local(a.id).entry.ino, 1);
    await s.pool.close(b.id);
    assert.equal(s.pool.closed(b.id), true, 'logical close is immediate while retirement is queued');
    assert.ok((await s.retiredNext()).includes(b.id), 'the next exchange retires it');
    assert.equal(s.pool.closed(b.id), false, 'after acknowledgement the authority rejects the retired number');
    assert.equal(s.held.has(b.id), false);
    assert.ok(s.held.has(a.id), 'the required open remains real');
    assert.equal(s.pool.owns(a.id), true);
    await s.recall();
    assert.equal(s.pool.local(a.id), null, 'revocation disables locality, not the real descriptor');
    assert.equal(s.held.has(a.id), true);
  } finally { await s.close(); }
}

// A change below a predicted directory (its subtree's revision moves) leaves the prediction good.
{
  const s = fixture();
  await s.pool.open('/d0', 'd0', async () => ['/d1']);
  s.nodes.set('d1', { ...s.nodes.get('d1'), revision: 40 });
  const sent = s.calls.length;
  await s.pool.open('/d1', 'd1', async () => { throw new Error('served from the batch'); });
  assert.equal(s.calls.length, sent, 'claimed: same identity, mode, owner and ctime');
  await s.close();
}

// A walk that opens what was not guessed keeps what was: a miss is no invalidation.
{
  const s = fixture();
  await s.pool.open('/d0', 'd0', async () => ['/d1', '/d2']);
  await s.pool.open('/d5', 'd5', async () => ['/d1', '/d6']);
  assert.deepEqual(s.calls[1].open, ['/d5', '/d6'], 'what is already prefetched is not asked for again');
  assert.deepEqual(s.calls[1].retire, [], 'nor retired');
  assert.equal(s.calls[1].claim.length, 3, 'but claimed at the session, which closes what an advance leaves unclaimed (d0, and d1 and d2 kept)');
  const sent = s.calls.length;
  await s.pool.open('/d2', 'd2', async () => { throw new Error('served from the first batch'); });
  assert.equal(s.calls.length, sent, 'the first batch still serves after the miss');
  await s.close();
}

// The process's own change distrusts the predictions, and retires none: the
// next batch's answer revalidates each against the store.
{
  const s = fixture();
  await s.pool.open('/d0', 'd0', async () => ['/d1', '/d2']);
  const predicted = [...s.held].find(([, item]) => item.handle.path === 'd1')[0];
  s.pool.invalidate();
  s.nodes.set('d1', { ...s.nodes.get('d1'), ctime: 9 });
  await s.pool.open('/d2', 'd2', async () => []);
  assert.equal(s.calls.length, 2, 'distrusted: the open asks the session');
  assert.equal(s.calls[1].retire.includes(predicted), false, 'and keeps the other predictions');
  assert.equal(s.calls[1].claim.includes(predicted), true, 'claimed at the session');
  const sent = s.calls.length;
  const d1 = await s.pool.open('/d1', 'd1', async () => []);
  assert.equal(s.calls.length, sent + 1, 'a prediction whose directory changed is not claimed');
  assert.ok(s.calls[sent].retire.length >= 1, 'it is retired');
  assert.equal(s.pool.owns(d1.id), true);
  await s.close();
}

// A session that cannot account for another channel (a shell's scope full of
// runs whose ends never arrived) makes the batch unavailable: the directory
// is opened as any is (null), and the pool asks no more.
{
  const s = fixture();
  s.hook = () => { throw Object.assign(new Error('ENOSPC: too many directory prefetch channels'), { code: 'ENOSPC' }); };
  assert.equal(await s.pool.open('/d0', 'd0', async () => ['/d1']), null, 'the caller opens it itself');
  const asked = s.calls.length;
  assert.equal(await s.pool.open('/d1', 'd1', async () => []), null);
  assert.equal(s.calls.length, asked, 'and the pool asks the session no more');
  s.hook = null;
}

// The run ends even when an exchange is never answered (a park the watchdog
// gave up on): its end is sent at once, and waited for at most endWaitMs.
{
  const s = fixture({ endWaitMs: 20 });
  await s.pool.open('/d0', 'd0', async () => ['/d1']);
  s.hook = () => new Promise(() => {});
  const hung = s.pool.open('/d5', 'd5', async () => []);
  hung.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  const sent = s.calls.length;
  await s.pool.dispose();
  assert.equal(s.calls.length, sent + 1, 'the end went out beside the unanswered exchange');
  assert.equal(s.calls[sent].end, true);
}

// Lost/late first answer: the original ask cannot be replaced by arrival time.
{
  const s = fixture(), reached = deferred(), finish = deferred();
  s.hook = async (_request, answer) => { reached.resolve(); await finish.promise; return answer; };
  const opened = s.pool.open('/d0', 'd0', async () => ['/d1']);
  await reached.promise;
  s.clock(2000); // expiry and an intervening writer before the old answer arrives
  s.nodes.set('d0', { ...s.nodes.get('d0'), mtime: 99, revision: 2 });
  finish.resolve();
  const handle = await opened;
  assert.equal(s.pool.local(handle.id), null);
  assert.equal(s.nodes.get('d0').mtime, 99, 'the authority, not the expired answer, owns the later state');
  assert.equal(s.pool.owns(handle.id), true, 'an already-required descriptor is retained');
  s.hook = null;
  await s.close();
}

// Recall during admission: ownership is registered before the admission yields.
{
  const s = fixture(), entered = deferred(), finish = deferred();
  s.admission = async () => { entered.resolve(); await finish.promise; };
  const opened = s.pool.open('/d0', 'd0', async () => ['/d1']);
  await entered.promise;
  await s.recall();
  finish.resolve();
  const handle = await opened;
  assert.equal(s.pool.local(handle.id), null);
  s.admission = null;
  await s.close();
}

// The descriptor's stat is the final admitted namespace, never the early open stat.
{
  const s = fixture();
  s.hook = async (_request, answer) => ({ ...answer, acquire: { ...answer.acquire, rev: 2,
    paths: [{ path: 'd0', stat: { ...s.nodes.get('d0'), revision: 2, mtime: 55 } },
      { path: 'd1', stat: { ...s.nodes.get('d1'), revision: 2, mode: 0 } }] } });
  const handle = await s.pool.open('/d0', 'd0', async () => ['/d1']);
  assert.equal(s.pool.local(handle.id).entry.mtime, 55);
  s.hook = null;
  await assert.rejects(() => s.pool.open('/d1', 'd1', async () => []), { code: 'EACCES' }, 'a changed permission stamp is not a new open authorization');
  await s.close();
}

// A watchdog/timer is not an I/O observation; a late open must not install an fd.
{
  const s = fixture(), reached = deferred(), finish = deferred();
  s.hook = async (_request, answer) => { reached.resolve(); await finish.promise; return answer; };
  const opened = s.pool.open('/d0', 'd0', async () => ['/d1']);
  const refused = assert.rejects(opened, { code: 'EAGAIN' });
  await reached.promise;
  s.pool.cancelPending(); // frozen clock: do not call io() here
  finish.resolve();
  await refused;
  s.hook = null;
  const late = [...s.held.keys()];
  assert.deepEqual((await s.retiredNext()).filter((id) => late.includes(id)).sort(), late.sort(), 'the abandoned late descriptions are retired, never installed');
  await s.close();
}
// An admission failure still owes every descriptor the server already issued.
{
  const s = fixture();
  s.admission = async () => { throw new Error('store admission refused'); };
  await assert.rejects(() => s.pool.open('/d0', 'd0', async () => ['/d1']), /store admission refused/);
  const received = [...s.held.keys()];
  assert.equal(received.length, 2);
  s.admission = null;
  assert.deepEqual((await s.retiredNext()).filter((id) => received.includes(id)).sort(), received.sort(), 'no received ID was lost between receipt and admission');
  await s.close();
}
// A close that cannot wait (a synchronous caller's) queues its retirement
// and begins no exchange, however full the queue. Red before: the close that
// filled the queue waited on its retirement.
{
  const s = fixture();
  for (let i = 100; i < 140; i++) s.nodes.set(`d${i}`, { ...s.nodes.get('d0'), ino: i + 1 });
  // Every description the pool may hold, open: closed, they fill its retirement queue.
  const ids = [];
  for (let i = 0; i < 140; i++) {
    const opened = await s.pool.open(`/d${i}`, `d${i}`, async () => []);
    if (opened === null) break;
    ids.push(opened.id);
  }
  assert.equal(ids.length, DIRECTORY_PREFETCH_LIMIT);
  const sent = s.calls.length;
  for (const id of ids) assert.equal(s.pool.close(id, false), undefined, 'a close that cannot wait began a retirement exchange');
  assert.equal(s.calls.length, sent);
  await s.close();
}
console.log('read-directory-pool: original ask, recall ordering, final namespace, late parks and bounded lifetime');
