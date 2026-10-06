#!/usr/bin/env bun
// A write stream authorises its files a group at a time, in the turn the
// group commits, and finds what each replaces with one read per group.
//
// Red before: every streamed file was authorised alone at its file-begin
// and looked up the (absent) row at its path: one SELECT per new file
// (lookups ~= files); and the check ran a whole group's worth of awaits
// before the commit it guarded.
//
// Exactness: whatever changes between a file's arrival and its group's
// commit (a chmod, a chown, a link replacing a directory) is what the
// commit is checked against.

import assert from 'node:assert/strict';

import { encodeWriteBatchStream } from '../../packages/platform/src/w7-frame.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const USER = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });
const enc = new TextEncoder();

function setup() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('home/user', { recursive: true, mode: 0o755 });
  kernel.chown('home/user', 1000, 1000);
  return { harness, raw, kernel, user: raw.as(USER) };
}

function payload(dir, count, size = 40) {
  const inodes = [];
  const chunks = [];
  for (let index = 0; index < count; index++) {
    const data = enc.encode(`file ${index} `.padEnd(size, '.'));
    const path = `${dir}/f${index}`;
    inodes.push({ path, parentPath: dir, kind: 'file', isDir: false, size: data.byteLength, mtime: 1, mode: 0o644, chunkCount: 1 });
    chunks.push({ path, chunkId: 0, data });
  }
  return { inodes, chunks };
}

/** A byte stream of `bytes` that runs `atHalf` once the consumer has read half of it. */
function pausing(bytes, atHalf) {
  let offset = 0;
  let fired = false;
  return new ReadableStream({
    type: 'bytes',
    async pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        controller.byobRequest?.respond(0);
        return;
      }
      if (!fired && offset >= bytes.byteLength / 2) {
        fired = true;
        await atHalf();
      }
      const length = Math.min(bytes.byteLength - offset, 512);
      controller.enqueue(bytes.slice(offset, offset + length));
      offset += length;
    },
  });
}

const encode = async (wave) => new Uint8Array(await new Response(encodeWriteBatchStream(wave)).arrayBuffer());

// ── One read per group, not one per file ───────────────────────────────
{
  const { harness, user } = setup();
  user.mkdir('home/user/a', { recursive: true });
  const files = 120;
  const before = harness.statements.filter((statement) => statement.sql.startsWith('SELECT path, parent_path')).length;
  const result = await user.writeStream(encodeWriteBatchStream(payload('home/user/a', files)));
  assert.equal(result.ok, true, result.error?.message);
  const lookups = harness.statements.filter((statement) => statement.sql.startsWith('SELECT path, parent_path')).length - before;
  assert.ok(lookups <= 10, `${lookups} inode lookups placed ${files} new files in one group`);
  console.log(`  ok  ${files} new files, ${lookups} inode lookups`);
}

// ── A chmod between a file's arrival and its group's commit is honoured ─
{
  const { kernel, user } = setup();
  user.mkdir('home/user/locked', { recursive: true });
  const bytes = await encode(payload('home/user/locked', 40));
  const result = await user.writeStream(pausing(bytes, () => kernel.chmod('home/user/locked', 0o555)));
  assert.equal(result.ok, false, 'a group committed into a directory made read-only before its commit');
  assert.match(result.error.message, /EACCES/);
  assert.equal(user.readdir('home/user/locked').length, 0, 'part of the group committed');
  console.log('  ok  a chmod before the group commits refuses the whole group');
}

// ── A chown between arrival and commit is honoured ──────────────────────
{
  const { kernel, user } = setup();
  user.mkdir('home/user/taken', { recursive: true, mode: 0o755 });
  const bytes = await encode(payload('home/user/taken', 40));
  const result = await user.writeStream(pausing(bytes, () => kernel.chown('home/user/taken', 0, 0)));
  assert.equal(result.ok, false, 'a group committed into a directory given away before its commit');
  assert.match(result.error.message, /EACCES/);
  console.log('  ok  a chown before the group commits refuses the whole group');
}

// ── A link that replaces a directory before the commit is followed ─────
{
  const { user } = setup();
  user.mkdir('home/user/old', { recursive: true });
  user.mkdir('home/user/elsewhere', { recursive: true });
  const bytes = await encode(payload('home/user/old', 40));
  const result = await user.writeStream(pausing(bytes, () => {
    user.rename('home/user/old', 'home/user/moved');
    user.symlink('elsewhere', 'home/user/old');
  }));
  assert.equal(result.ok, true, result.error?.message);
  // Files placed before the swap and after it all land where the name
  // resolves when their group commits: through the link.
  assert.equal(user.readdir('home/user/elsewhere').length, 40, 'the group did not follow the link that replaced its directory');
  assert.equal(user.readdir('home/user/moved').length, 0, 'files landed in the directory the name no longer names');
  for (const receipt of result.receipts) assert.ok(receipt.path.startsWith('home/user/old/'), `receipt ${receipt.path} is not named as streamed`);
  console.log('  ok  a link replacing the directory before the commit is where the group lands');
}

console.log('sqlite vfs write stream group authorisation: ok');
