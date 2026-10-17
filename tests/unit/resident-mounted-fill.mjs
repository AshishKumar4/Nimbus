#!/usr/bin/env bun
// A resident store fills a file a launch listed from a mounted backend, and
// a mounted read is checked by the file a listing named, not by the
// engine's revisions, which name none:
//   - synchronously mounted, the walked file fills (ticket
//     resident-sync-mount-fill, its repro);
//   - the file changed after the listing, before the read: refused ESTALE,
//     and the store holds neither version as the listed one;
//   - a file the engine keeps fills as before, by its revision;
//   - through the bridge alone, sync and async mounts alike: a read naming
//     the file as its stat does reads it; one naming a different file, or
//     the engine's revisions, is ESTALE.
//
// Red before: the synchronous bridge refused every read of a mounted path
// that carried the engine's epoch, and the resident's fetch carried it for
// every file, so a file under a synchronous mount never filled.

import assert from 'node:assert/strict';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { createResidentStore } from '../../packages/worker/src/vfs/resident/index.ts';
import { createAuthority, facetSql, facetSupervisor } from './lib/resident-body.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A synchronous MemoryVFS behind an awaited face only, as a remote backend is. */
const remote = (vfs) => new Proxy(vfs, {
  get(target, key) {
    if (key === 'sync') return undefined;
    const value = target[key];
    if (typeof value !== 'function') return value;
    return async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return value.apply(target, args);
    };
  },
  has(target, key) { return key !== 'sync' && key in target; },
});

/** An authority with `backing` mounted at /m, and a store whose launch walked /m/kept. */
function launched({ async = false, beforeRead } = {}) {
  const authority = createAuthority();
  const backing = new MemoryVFS({ uid: 1000, gid: 1000 });
  backing.mkdir('/kept');
  backing.writeFile('/kept/data.txt', enc.encode('old'));
  authority.kfs.writeFile('home/user/own.txt', enc.encode('own'));
  authority.files.vfs.mount('/m', async ? remote(backing) : backing);
  const reads = [];
  const handle = facetSupervisor(authority, {
    async fsReadBatch(requests) {
      await beforeRead?.(backing);
      const results = await handle.forward('fsReadBatch', [requests]);
      reads.push(...results.map((entry, at) => ({ path: requests[at].path, bytes: entry.bytes?.length, code: entry.error?.code })));
      return results;
    },
  });
  const binding = { pid: handle.log.pid, cred: authority.host.processes.cred(handle.log.pid) };
  authority.files.nameLaunch(binding, () => ['/m/kept', '/home/user']);
  const store = createResidentStore();
  store.bind({ storage: { sql: facetSql() } });
  store.sync.setPlan(['m/kept/data.txt', 'home/user/own.txt']);
  store.sync.adoptModuleBundle({}, authority.cursor());
  return { authority, backing, handle, binding, store, reads };
}

const failed = [];
async function check(label, body) {
  try {
    await body();
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.log(`  FAIL  ${label}: ${String(error?.message ?? error).split('\n').slice(0, 3).join(' | ')}`);
    failed.push(label);
  }
}

await check('a walked file under a synchronous mount fills', async () => {
  const { authority, handle, binding, store, reads } = launched();
  try {
    const report = await store.sync.synchronize(handle.supervisor);
    assert.equal(report.filled, 2, `both planned files fill: ${JSON.stringify({ report, reads })}`);
    assert.equal(dec.decode(store.cells.get('m/kept/data.txt')), 'old');
    assert.equal(dec.decode(store.cells.get('home/user/own.txt')), 'own', 'a file the engine keeps, by its revision');
  } finally {
    await authority.files.releaseProcess(binding.pid);
  }
});

await check('a mounted file changed after the listing is refused, not held as listed', async () => {
  const { authority, handle, binding, store, reads } = launched({
    beforeRead: (backing) => { backing.writeFile('/kept/data.txt', enc.encode('changed since')); },
  });
  try {
    await store.sync.synchronize(handle.supervisor);
    const read = reads.find((entry) => entry.path === '/m/kept/data.txt' || entry.path === 'm/kept/data.txt');
    assert.equal(read?.code, 'ESTALE', `the read names the listed file, which is no more: ${JSON.stringify(reads)}`);
    const held = store.cells.get('m/kept/data.txt');
    assert.ok(held === undefined || held === null || dec.decode(held) !== 'old', 'the listed version is not held');
  } finally {
    await authority.files.releaseProcess(binding.pid);
  }
});

for (const async of [false, true]) {
  await check(`the bridge, ${async ? 'asynchronously' : 'synchronously'} mounted`, async () => {
    const { authority, binding } = launched({ async });
    try {
      const bridge = authority.files.bind(binding);
      const stat = await bridge.stat('/m/kept/data.txt');
      assert.ok(stat, 'the mounted file stats');
      const version = { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtime, ctime: stat.ctime, revision: stat.revision };
      assert.equal(dec.decode(await bridge.readRange('/m/kept/data.txt', 0, 3, { expectedFile: version })), 'old', 'the file its stat names');
      const stale = async (options) => {
        try { await bridge.readRange('/m/kept/data.txt', 0, 3, options); }
        catch (error) { return error?.code; }
        return 'read';
      };
      assert.equal(await stale({ expectedFile: { ...version, mtime: version.mtime + 1 } }), 'ESTALE', 'another version');
      assert.equal(await stale({ expectedFile: { ...version, ino: version.ino + 1 } }), 'ESTALE', 'another file');
      assert.equal(await stale({ expectedEpoch: authority.rawVfs.epoch, expectedRevision: 0 }), 'ESTALE', 'the engine\'s revisions name no mounted file');
    } finally {
      await authority.files.releaseProcess(binding.pid);
    }
  });
}

assert.deepEqual(failed, [], 'a mounted file fills by what its listing named');
console.log('resident-mounted-fill: ok');
