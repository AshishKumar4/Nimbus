// A mount appearing after a SQLite-only listing must invalidate that listing.
import assert from 'node:assert/strict';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { createAuthority, facetSql, facetSupervisor } from './lib/resident-body.mjs';

const authority = createAuthority();
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
  authority.files.vfs.mount('/m', new MemoryVFS({ uid: 1000, gid: 1000 }));
  const cursor = store.coherence.cursor();
  const answer = await supervisor.fsAcquire(cursor.epoch, cursor.rev, { namespace: true });
  if (answer.poison) await store.sync.synchronize(supervisor);
  else await store.sync.applyAcquire(supervisor, answer);
  const live = await bridge.stat('/m');
  const staged = store.namespace.rowAt('m');
  console.log(JSON.stringify({ poison: answer.poison, paths: answer.paths, liveDirectory: live?.type, stagedDirectory: staged ?? null }));
  assert.equal(answer.poison, true, 'the added mount must poison the SQLite-only listing');
  assert.ok(staged, 'the repaired resident namespace must include the new mount directory');
} finally {
  await authority.files.releaseProcess(binding.pid);
}
