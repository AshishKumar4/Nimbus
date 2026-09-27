#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { FS_LIST_PAGE_LIMIT, MAX_RPC_SAFE_PAYLOAD_BYTES } from '../../packages/core/src/constants.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';
const h = createSqliteVfsTestHarness();
try {
  const fs = new SqliteVFS(h.sql,h.ctx).as(CRED_KERNEL);
  fs.mkdir('home/user/links',{recursive:true});
  // Every target is below POSIX PATH_MAX and each component below NAME_MAX;
  // JSON escaping makes a count-only page exceed the 28MiB RPC budget.
  const target = Array(16).fill(('x"\\'.repeat(85))).join('/');
  const expected = new Set(['home','home/user','home/user/links']);
  for (let i=0;i<8190;i++) { const key='home/user/links/link'+String(i).padStart(5,'0'); fs.symlink(target,key);expected.add(key); }
  let after = null, pages = 0;
  const seen = new Set();
  do {
    const page = fs.list(after,FS_LIST_PAGE_LIMIT);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= MAX_RPC_SAFE_PAYLOAD_BYTES, 'a page fits the encoded RPC frame');
    for(const entry of page.entries){assert.ok(!seen.has(entry.path),'no duplicate cursor entry');seen.add(entry.path);if(entry.kind==='symlink')assert.equal(entry.linkTarget,target);}
    if(page.next!==null){assert.ok(page.entries.length>0);assert.equal(page.next,page.entries.at(-1).path);assert.notEqual(page.next,after,'cursor makes progress');}
    after=page.next; pages++;
    assert.ok(pages<10,'listing terminates');
  } while(after!==null);
  assert.deepEqual(seen,expected,'byte pagination loses no names');
  assert.ok(pages>1,'the old single oversized frame is split');
  console.log('fslist-byte-bound: escaped path/target bytes paginate without omissions');
}finally{h.db.close();}
