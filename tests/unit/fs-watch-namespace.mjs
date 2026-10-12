#!/usr/bin/env bun
// The file tree's fs-watch hears the session's namespace (VFS-2b): a change
// on SQLite and one on a mount under the watched tree both reach the
// socket, as the wire has always carried them (VfsEvent, paths without the
// leading slash); a change outside it, and one after unsubscribe, do not.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { ProcessFiles } from '../../packages/core/src/runtime/process-files.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { handleFsWatchSubscribe, handleFsWatchUnsubscribe } from '../../packages/worker/src/session/fs-watch.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const kernel = raw.as(CRED_KERNEL);
kernel.mkdir('home/user', { recursive: true });
kernel.mkdir('etc', { recursive: true });
const files = new ProcessFiles(raw);
files.vfs.mount('/home/user/drive', new MemoryVFS());
const host = { sqliteFs: raw, getFilesystemAuthority: () => files };
const sent = [];
const ws = { send: (frame) => sent.push(JSON.parse(frame)) };
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

const subscribed = handleFsWatchSubscribe(host, ws, { paths: ['/home/user', '/home/user/drive'] });
assert.equal(subscribed.ok, true);
kernel.writeFile('home/user/notes.txt', 'n');
await files.vfs.writeFile('/home/user/drive/report.txt', new TextEncoder().encode('r'));
kernel.writeFile('etc/elsewhere', 'e');
await settle();
const events = sent.flatMap((frame) => frame.events.map((event) => `${event.type} ${event.path}`));
assert.deepEqual(events, ['add home/user/notes.txt', 'change home/user/drive/report.txt'], 'each change in the tree, once, as the wire names it');
assert.ok(sent.every((frame) => frame.type === 'fs-watch-event' && frame.subId === subscribed.subId));

assert.equal(handleFsWatchUnsubscribe(host, ws, {}).removed, 1);
sent.length = 0;
kernel.writeFile('home/user/after.txt', 'a');
await files.vfs.writeFile('/home/user/drive/after.txt', new TextEncoder().encode('a'));
await settle();
assert.deepEqual(sent, [], 'nothing after unsubscribe');
console.log('fs-watch-namespace: ok');
