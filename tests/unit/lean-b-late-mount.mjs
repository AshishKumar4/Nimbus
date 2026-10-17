// A mount appearing after a SQLite-only listing must invalidate that listing.
import assert from 'node:assert/strict';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { createResidentStore, NS_DIR } from '../../packages/worker/src/vfs/resident/index.ts';
import { createAuthority, facetSql, facetSupervisor } from './lib/resident-body.mjs';

async function check(kind) {
  const sourceWasAbsent = kind === 'source';
  const authority = createAuthority();
  const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
  let connected = false;
  if (sourceWasAbsent) authority.files.vfs.mount('/m', () => connected ? backing : null);
  const { supervisor, log } = facetSupervisor(authority);
  const binding = { pid: log.pid, cred: authority.host.processes.cred(log.pid) };
  const bridge = authority.files.bind(binding);
  const store = createResidentStore();
  store.bind({ storage: { sql: facetSql() } });
  store.sync.setPlan([]);
  store.sync.adoptModuleBundle({}, authority.cursor());
  try {
    const boot = await store.sync.synchronize(supervisor);
    assert.equal(boot.complete, true, 'the SQLite-only namespace was listed');
    assert.equal(store.namespace.rowAt('m'), undefined);
    if (sourceWasAbsent) connected = true;
    else {
      authority.files.vfs.mount('/m', backing);
      if (kind === 'aba') authority.files.vfs.unmount('/m');
    }
    const cursor = store.coherence.cursor();
    const answer = await supervisor.fsAcquire(cursor.epoch, cursor.rev, { namespace: true });
    if (answer.poison) await store.sync.synchronize(supervisor);
    else await store.sync.applyAcquire(supervisor, answer);
    const live = await bridge.stat('/m');
    const staged = store.namespace.rowAt('m');
    console.log(JSON.stringify({ kind, poison: answer.poison, paths: answer.paths, liveDirectory: live?.type, stagedDirectory: staged ?? null }));
    assert.equal(live?.type, kind === 'aba' ? undefined : 'directory');
    assert.equal(answer.poison, true, 'the new live mount must poison the SQLite-only listing');
    assert.equal(staged?.kind, kind === 'aba' ? undefined : NS_DIR, 'the repaired namespace matches the final table');
    const repaired = store.coherence.cursor();
    const next = await supervisor.fsAcquire(repaired.epoch, repaired.rev, { namespace: true });
    assert.equal(next.poison, false, 'the relist acknowledges the new table, including an ABA');
  } finally {
    await authority.files.releaseProcess(binding.pid);
  }
}

await check('mount');
await check('source');
await check('aba');
