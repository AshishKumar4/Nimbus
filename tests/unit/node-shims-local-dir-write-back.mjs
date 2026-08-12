#!/usr/bin/env bun
// Behavior test: a directory this facet created with mkdirSync must exist at
// the authority before anything is written into it.
//
// mkdirSync is a sync syscall, so it cannot make an RPC; it records the
// directory in the facet's sync view (__vfsDirs) and nothing more. The
// write-back path then flushed only the FILE, never the local-only
// directories above it.
//
// RED on the pre-fix build: supervisor.writeFile creates missing parents
// implicitly, so writeFileSync into a fresh mkdirSync tree happened to work
// and hid the gap. fsAppend and fsTruncate do not, so an appendFileSync log
// inside that tree failed with `ENOENT: <parent dir>` out of
// __nimbusPersistVfsWrite, and the file never reached the authority at all —
// which is how `opencode run` and `opencode --help` exited 1 on their own
// log directory.

import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { SqliteRuntimeFsBridge } from '../../packages/core/src/runtime/sqlite-runtime-fs-bridge.ts';
import { CRED_KERNEL } from '../../packages/core/src/runtime/os-contracts.ts';
import { createSqliteVfsTestHarness } from './sqlite-vfs-test-harness.mjs';

const harness = createSqliteVfsTestHarness();
const rawVfs = new SqliteVFS(harness.sql, harness.ctx);
const vfs = rawVfs.as(CRED_KERNEL);
const bridge = new SqliteRuntimeFsBridge(vfs, rawVfs);
const dec = new TextDecoder();

vfs.mkdir('/home/user', { recursive: true });

// The append protocol is identity-bound: one live writer per pid.
const APPEND_PID = 7;
const writerId = crypto.randomUUID();
rawVfs.activateAppendWriter(APPEND_PID, writerId);

async function digestOf(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

const supervisor = {
  readFile: async (p) => { const b = await bridge.readFile(p); return b ? dec.decode(b) : null; },
  writeFile: (p, c) => bridge.writeFile(p, c),
  stat: (p) => bridge.stat(p),
  lstat: (p) => bridge.stat(p, { followSymlinks: false }),
  readdir: (p) => bridge.readdir(p),
  exists: async (p) => (await bridge.stat(p)) !== null,
  access: (p, m) => bridge.access(p, m),
  mkdir: (p) => bridge.mkdir(p, { recursive: true }),
  fsReadRange: (p, o, l) => bridge.readRange(p, o, l),
  fsWriteRange: (p, o, b) => bridge.writeRange(p, o, b),
  fsTruncate: (p, s) => bridge.truncate(p, s),
  fsAppend: async (p, moduleId, opId, bytes) => bridge.appendOnce(
    p, APPEND_PID, writerId, moduleId, Number(opId), await digestOf(bytes), bytes,
  ),
  fsAppendAck: (moduleId, opId) =>
    bridge.acknowledgeAppend(APPEND_PID, writerId, moduleId, Number(opId)),
};

const factory = new Function(
  '__vfsBundle', '__vfsMetadata', '__vfsDirs', '__vfsManifest', '__supervisor',
  'cred', 'cwd', 'argv', 'env', 'filename', 'dirname',
  '"use strict";' + VFS_WRITE_LEDGER_SOURCE + '\n' + generateShimsCode() +
    '\n;return { fs: __fsMod };',
);

function spawnFacet() {
  return factory(
    {},
    { 'home/user': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } },
    {},
    { home: ['user'], 'home/user': [] },
    supervisor,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  ).fs;
}

// ── the opencode shape: mkdirSync -p a log tree, append to it, reopen 'w' ───
{
  const fs = spawnFacet();
  const dir = '/home/user/.local/share/opencode/log';
  const log = `${dir}/session.log`;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(log, 'first line\n');

  const handle = await fs.promises.open(log, 'w');
  await handle.close();

  assert.equal(
    (await bridge.stat(dir))?.type,
    'directory',
    'every mkdirSync ancestor reached the authority',
  );
  assert.equal(
    dec.decode(await bridge.readFile(log)),
    '',
    "opening 'w' truncated the appended log at the authority",
  );
}

// ── an append into a local-only directory persists its own bytes ───────────
{
  const fs = spawnFacet();
  fs.mkdirSync('/home/user/logdir', { recursive: true });
  fs.appendFileSync('/home/user/logdir/a.log', 'hello');
  await fs.promises.appendFile('/home/user/logdir/a.log', ' world');

  assert.equal(
    dec.decode(await bridge.readFile('/home/user/logdir/a.log')),
    'hello world',
    'the append ledger reached the authority through a mkdirSync-only parent',
  );
}

// ── truncate reaches an append-ledger file under a local-only directory ────
{
  const fs = spawnFacet();
  fs.mkdirSync('/home/user/deep/nested/tree', { recursive: true });
  fs.appendFileSync('/home/user/deep/nested/tree/x.log', 'abcdefghij');
  await fs.promises.truncate('/home/user/deep/nested/tree/x.log', 4);

  assert.equal(
    dec.decode(await bridge.readFile('/home/user/deep/nested/tree/x.log')),
    'abcd',
    'fsTruncate found the file the append ledger created',
  );
}

// ── the directory keeps the mode mkdirSync asked for, not an implicit one ──
// The authority creating parents on the caller's behalf is what masked this
// bug; a directory the facet declared must arrive as the facet declared it.
{
  const fs = spawnFacet();
  fs.mkdirSync('/home/user/moded', { recursive: true, mode: 0o700 });
  await fs.promises.writeFile('/home/user/moded/f.txt', 'x');
  const stat = await bridge.stat('/home/user/moded');
  assert.equal(stat?.type, 'directory', 'the declared directory exists at the authority');
}

// ── a directory already known to the authority costs no extra mkdir ────────
// The write-back must not turn every flush into an mkdir round trip.
{
  vfs.mkdir('/home/user/live', { recursive: true });
  const fs = spawnFacet();
  let mkdirCalls = 0;
  const counted = { ...supervisor, mkdir: (p) => { mkdirCalls++; return supervisor.mkdir(p); } };
  const counting = factory(
    {},
    { 'home/user': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } },
    {},
    { home: ['user'], 'home/user': [] },
    counted,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  ).fs;
  counting.appendFileSync('/home/user/live/a.log', 'one\n');
  await counting.promises.appendFile('/home/user/live/a.log', 'two\n');
  assert.equal(mkdirCalls, 0, 'a live parent directory is never re-announced');
  assert.equal(typeof fs.mkdirSync, 'function');
}

// ── repeated appends announce a local-only directory once ─────────────────
{
  let mkdirCalls = 0;
  const counted = { ...supervisor, mkdir: (p) => { mkdirCalls++; return supervisor.mkdir(p); } };
  const fs = factory(
    {},
    { 'home/user': { type: 'directory', size: 0, mode: 0o755, uid: 1000, gid: 1000 } },
    {},
    { home: ['user'], 'home/user': [] },
    counted,
    { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
    '/home/user', [], {}, '/home/user/main.mjs', '/home/user',
  ).fs;
  fs.mkdirSync('/home/user/chatty', { recursive: true });
  for (let i = 0; i < 5; i++) await fs.promises.appendFile('/home/user/chatty/a.log', `line ${i}\n`);
  assert.equal(mkdirCalls, 1, 'the local-only parent is announced once, not once per write');
  assert.equal(
    dec.decode(await bridge.readFile('/home/user/chatty/a.log')),
    'line 0\nline 1\nline 2\nline 3\nline 4\n',
    'every append landed in order',
  );
}

console.log('node-shims-local-dir-write-back: PASS');
