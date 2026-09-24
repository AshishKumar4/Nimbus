#!/usr/bin/env bun
// A watch follows its caller's view.
//
// The runtime bridge's subscribe, the primitive under fs.watch, registered
// the watch on the name as written, and events carry storage keys. So a
// confined caller watching /tmp/x watched the SHARED tmp/x: its own writes to
// its private /tmp/x never fired, and the shared file's did. A watch on a
// directory also delivered every event beneath it, inside directories the
// caller cannot traverse. A watch now sits on the file the caller's name
// means, reports each event under the caller's name, and only for paths the
// caller could list, by the rule an ACQUIRE delta uses.

import assert from 'node:assert/strict';

import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteFilesystemAuthority } from '../../packages/core/src/runtime/filesystem-authority.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const A = Object.freeze({ uid: 5001, gid: 5001, groups: Object.freeze([5001]), umask: 0o022 });
const B = Object.freeze({ uid: 5002, gid: 5002, groups: Object.freeze([5002]), umask: 0o022 });
const PLAIN = Object.freeze({ uid: 1000, gid: 1000, groups: Object.freeze([1000]), umask: 0o022 });

const harness = createSqliteVfsTestHarness();
const raw = new SqliteVFS(harness.sql, harness.ctx);
const root = raw.as(CRED_KERNEL);
root.mkdir('tmp', { mode: 0o1777 });
root.chmod('tmp', 0o1777);
for (const [who, key] of [[A, 'var/agents/a/tmp'], [B, 'var/agents/b/tmp']]) {
  root.mkdir(key, { recursive: true, mode: 0o755 });
  root.chmod(key, 0o700);
  root.chown(key, who.uid, who.gid);
  raw.confinePrincipal(who.uid, key);
}
root.mkdir('home/user', { recursive: true, mode: 0o755 });
root.chown('home/user', PLAIN.uid, PLAIN.gid);
root.mkdir('home/b', { mode: 0o755 });
root.chown('home/b', B.uid, B.gid);

const a = raw.as(A);
const b = raw.as(B);
const plain = raw.as(PLAIN);
const authority = new SqliteFilesystemAuthority(raw);
const aFs = authority.bind({ pid: 7101, cred: A });
const plainFs = authority.bind({ pid: 7102, cred: PLAIN });

function watch(fs, path) {
  const seen = [];
  const stop = fs.subscribe(path, (event) => {
    seen.push(event.oldPath === undefined ? `${event.type} ${event.path}` : `${event.type} ${event.oldPath} -> ${event.path}`);
  });
  return { seen, stop, take: () => seen.splice(0) };
}

// ── /tmp/x is the caller's own /tmp/x ─────────────────────────────────────
{
  const file = watch(aFs, '/tmp/x');
  a.writeFile('/tmp/x', 'mine');
  root.writeFile('tmp/x', 'shared');
  a.writeFile('/tmp/x', 'mine again');
  b.writeFile('/tmp/x', 'B\'s own');
  assert.deepEqual(file.take(), ['add tmp/x', 'change tmp/x']);
  file.stop();
  a.writeFile('/tmp/x', 'after stop');
  assert.deepEqual(file.take(), [], 'a stopped watch still fired');
}

// ── A watched directory reports under the caller's names ──────────────────
{
  const dir = watch(aFs, '/tmp');
  a.mkdir('/tmp/d');
  a.writeFile('/tmp/d/f', 'f');
  b.writeFile('/tmp/b-file', 'b');
  root.writeFile('tmp/shared-file', 's');
  a.rename('/tmp/d/f', '/tmp/g');
  a.unlink('/tmp/g');
  assert.deepEqual(dir.take(), ['addDir tmp/d', 'add tmp/d/f', 'rename tmp/d/f -> tmp/g', 'unlink tmp/g']);
  dir.stop();
}

// ── Only what the caller could list ───────────────────────────────────────
{
  b.mkdir('/home/b/private');
  b.chmod('/home/b/private', 0o700);
  const home = watch(aFs, '/home');
  b.writeFile('/home/b/private/q', 'q');
  b.writeFile('/home/b/open.txt', 'o');
  plain.writeFile('/home/user/r', 'r');
  plain.rename('/home/user/r', '/home/user/r2');
  assert.deepEqual(home.take(), ['add home/b/open.txt', 'add home/user/r', 'rename home/user/r -> home/user/r2']);

  // A removed tree is reported as far as the caller could see into it: all
  // of a readable one, and only the name of a private one.
  plain.mkdir('/home/user/tree/sub', { recursive: true });
  plain.writeFile('/home/user/tree/sub/f', 'f');
  home.take();
  plain.removeRecursive('/home/user/tree');
  assert.deepEqual(home.take().sort(), [
    'unlink home/user/tree/sub/f',
    'unlinkDir home/user/tree',
    'unlinkDir home/user/tree/sub',
  ]);
  b.removeRecursive('/home/b/private');
  assert.deepEqual(home.take(), ['unlinkDir home/b/private']);
  home.stop();
}

// ── An unconfined watcher is held to the same rule ────────────────────────
{
  const agents = watch(plainFs, '/var/agents');
  a.writeFile('/tmp/for-a', 'a');
  b.writeFile('/tmp/for-b', 'b');
  assert.deepEqual(agents.take(), [], 'the session user learned a principal\'s private names');
  root.mkdir('var/agents/c');
  assert.deepEqual(agents.take(), ['addDir var/agents/c']);
  agents.stop();
}

console.log('confined-watch-view: ok');
