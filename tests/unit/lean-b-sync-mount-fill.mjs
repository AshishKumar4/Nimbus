// A launch-walked synchronous mount must be fillable by the resident store.
import assert from 'node:assert/strict';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { createAuthority, facetSql, facetSupervisor } from './lib/resident-body.mjs';

const authority = createAuthority();
const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
backing.mkdir('/kept');
backing.writeFile('/kept/data.txt', new TextEncoder().encode('old'));
authority.files.vfs.mount('/m', backing);
const reads = [];
const handle = facetSupervisor(authority, {
  async fsReadBatch(requests) {
    const results = await handle.forward('fsReadBatch', [requests]);
    reads.push({ requests, results: results.map((entry) => ({ bytes: entry.bytes?.length, code: entry.error?.code })) });
    return results;
  },
});
const binding = { pid: handle.log.pid, cred: authority.host.processes.cred(handle.log.pid) };
authority.files.nameLaunch(binding, () => ['/m/kept']);
const bridge = authority.files.bind(binding);
const store = createResidentStore();
store.bind({ storage: { sql: facetSql() } });
store.sync.setPlan(['m/kept/data.txt']);
store.sync.adoptModuleBundle({}, authority.cursor());
try {
  let found;
  for (let after = null; ;) {
    const page = await bridge.list(after);
    found ??= page.entries.find((entry) => entry.path === 'm/kept/data.txt');
    if (page.next === null) break;
    after = page.next;
  }
  assert.equal(found?.rev, 0, 'the real bound launch listing stages the mounted name at rev 0');
  const report = await store.sync.synchronize(handle.supervisor);
  console.log(JSON.stringify({ listedRevision: found.rev, report, reads }));
  assert.equal(report.filled, 1, 'the resident must fill the walked mounted file');
  assert.equal(new TextDecoder().decode(store.cells.get('m/kept/data.txt')), 'old');
} finally {
  await authority.files.releaseProcess(binding.pid);
}
