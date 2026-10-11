import assert from 'node:assert/strict';
import { processFsClient } from '../../packages/core/src/_shared/process-fs-client.ts';
import { readDirectoryPool } from '../../packages/core/src/runtime/wasi/read-directory-pool.ts';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture() {
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
        return { key, handle, dev: entry.dev, ino: entry.ino, openedRevision: entry.revision };
      });
      const answer = { channel: request.channel, sequence: request.sequence, opened, retired: request.retire, claimed: request.claim,
        outstanding: held.size, acquire: { epoch: 'E', rev: cursor.rev, paths: [], poison: false, namespace: true,
          ...(request.lease ? { readLease: { owner: 'L' + request.sequence, trustMs: 500 } } : {}) } };
      return s.hook ? s.hook(request, answer) : answer;
    },
  });
  s.pool = pool;
  s.recall = async () => { for (const finish of recalls.values()) finish('revoke'); await recalled.promise; };
  s.close = async () => { await pool.dispose(); await client.settle(); for (const finish of recalls.values()) finish(null); };
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
    await s.pool.flush();
    assert.equal(s.pool.closed(b.id), false, 'after acknowledgement the authority rejects the retired number');
    assert.equal(s.held.has(b.id), false);
    assert.equal(s.held.size, 1, 'unused prefetch is retired but the required open remains real');
    assert.equal(s.pool.owns(a.id), true);
    await s.recall();
    assert.equal(s.pool.local(a.id), null, 'revocation disables locality, not the real descriptor');
    assert.equal(s.held.has(a.id), true);
  } finally { await s.close(); }
  assert.equal(s.held.size, 0);
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
  assert.equal(s.held.size, 0);
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
  await s.close();
  assert.equal(s.held.size, 0);
}
console.log('read-directory-pool: original ask, recall ordering, final namespace, late parks and bounded lifetime');
