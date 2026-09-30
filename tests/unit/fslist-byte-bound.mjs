#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { FS_LIST_PAGE_LIMIT, MAX_RPC_SAFE_PAYLOAD_BYTES } from '../../packages/core/src/constants.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
const h = createSqliteVfsTestHarness();
try {
  const engine = new SqliteVFS(h.sql,h.ctx);
  const fs = engine.as(CRED_KERNEL);
  fs.mkdir('home/user/links',{recursive:true});
  // Every target is below POSIX PATH_MAX and each component below NAME_MAX;
  // JSON escaping makes a count-only page exceed the 28MiB RPC budget.
  const target = Array(16).fill(('x"\\'.repeat(85))).join('/');
  const expected = new Set(['home','home/user','home/user/links']);
  for (let i=0;i<8190;i++) { const key='home/user/links/link'+String(i).padStart(5,'0'); fs.symlink(target,key);expected.add(key); }
  const listAll = async (list) => {
    let after = null, pages = 0;
    const seen = new Set();
    do {
      const page = await list(after);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_RPC_SAFE_PAYLOAD_BYTES, 'a page fits the encoded RPC frame');
      for(const entry of page.entries){assert.ok(!seen.has(entry.path),'no duplicate cursor entry');seen.add(entry.path);if(entry.kind==='symlink')assert.equal(entry.linkTarget,target);}
      if(page.next!==null){assert.ok(page.entries.length>0);assert.equal(page.next,page.entries.at(-1).path);assert.notEqual(page.next,after,'cursor makes progress');}
      after=page.next; pages++;
      assert.ok(pages<10,'listing terminates');
    } while(after!==null);
    return { seen, pages };
  };
  const alone = await listAll((after) => fs.list(after,FS_LIST_PAGE_LIMIT));
  assert.deepEqual(alone.seen,expected,'byte pagination loses no names');
  assert.ok(alone.pages>1,'the old single oversized frame is split');
  // A process's listing with a mount beside SQLite re-cuts the namespace's
  // page, measuring SQLite's entries again under the paths it lists them by.
  const files = new ProcessFiles(engine);
  const memory = new MemoryVFS({ uid: 0, gid: 0 });
  files.vfs.mount('/m', new Proxy(memory, { get: (t, k) => (k === 'sync' ? undefined : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }));
  const bridge = files.bind({ pid: 7, cred: CRED_KERNEL });
  const mounted = await listAll((after) => bridge.list(after,FS_LIST_PAGE_LIMIT));
  assert.deepEqual(mounted.seen,new Set([...expected,'m']),'the mounted listing loses no names either');
  assert.ok(mounted.pages>1,'and splits its pages the same way');
  console.log('fslist-byte-bound: escaped path/target bytes paginate without omissions, with and without a mount');
}finally{h.db.close();}
