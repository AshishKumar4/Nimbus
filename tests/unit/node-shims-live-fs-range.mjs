#!/usr/bin/env bun
// Behavior tests for the generated Node dynamic-Worker fs shims against the
// REAL session: FileHandle positional read/write/truncate, fs.promises.truncate,
// and appendFile must reach the session as positional writes (not whole-file
// rewrites), and live session content stays authoritative.

import assert from 'node:assert/strict';
import { createAuthority } from './lib/resident-body.mjs';
import { observeWaves, shimsOnSession } from './lib/shims-on-session.mjs';

const authority = createAuthority();
authority.kfs.mkdir('home/user', { recursive: true });
authority.kfs.writeFile('home/user/log.txt', 'stale-snapshot\n');
// Seed a live-only file (outside the bundle).
authority.kfs.writeFile('home/user/live.bin', '0123456789abcdef');

// The session's records, as it receives them: each positional write, by path
// (a data call rides its file's record: its call, its offset and its size).
const positional = [];
const { fs } = shimsOnSession({
  authority,
  cwd: '/home/user',
  bundle: { 'home/user/log.txt': 'stale-snapshot\n' },
  overrides: (forward) => ({
    writeBatchStream: observeWaves(forward, (record) => {
      if (record.type === 'file-begin' && (record.inode.call === 'write' || record.inode.call === 'append')) {
        positional.push({ call: record.inode.call, path: record.inode.path, offset: record.inode.offset, size: record.inode.size });
      }
    }),
  }),
});
const fsp = fs.promises;
const enc = new TextEncoder();
const dec = new TextDecoder();
const live = (p) => authority.peer.readFileString(p);

await fsp.symlink('live.bin', '/home/user/live-link');
assert.equal((await fsp.stat('/home/user/live-link')).isFile(), true);
const liveLink = await fsp.lstat('/home/user/live-link');
assert.equal(liveLink.isSymbolicLink(), true);
assert.equal(liveLink.mode, 0o120777);
await assert.rejects(fsp.symlink('live.bin', '/home/user/live.bin'), /EEXIST/);
assert.equal(await live('home/user/live.bin'), '0123456789abcdef');

// open 'r' + positional FileHandle.read over live ranges
{
  const fh = await fsp.open('/home/user/live.bin', 'r');
  const buf = new Uint8Array(4);
  const r = await fh.read(buf, 0, 4, 6);
  assert.equal(r.bytesRead, 4);
  assert.equal(dec.decode(buf), '6789');
  const seq = await fh.read(new Uint8Array(3), 0, 3); // sequential from position 0
  assert.equal(seq.bytesRead, 3);
  assert.equal(dec.decode(seq.buffer), '012');
  await fh.close();
  await assert.rejects(fh.read(new Uint8Array(1), 0, 1), /EBADF/);
}

// open 'r' on a missing file throws ENOENT
await assert.rejects(fsp.open('/home/user/nope.bin', 'r'), /ENOENT/);

// open 'r+' positional write rewrites only the touched range live
{
  const fh = await fsp.open('/home/user/live.bin', 'r+');
  const w = await fh.write(enc.encode('XY'), 0, 2, 3);
  assert.equal(w.bytesWritten, 2);
  await fh.close();
  assert.equal(await live('home/user/live.bin'), '012XY56789abcdef');
}

// open 'w' truncates; writes land live; size tracked
{
  const fh = await fsp.open('/home/user/live.bin', 'w');
  await fh.write(enc.encode('fresh'));
  await fh.write(enc.encode('!'), 0, 1, 5);
  await fh.close();
  assert.equal(await live('home/user/live.bin'), 'fresh!');
}

// open 'a' appends at live EOF
{
  const fh = await fsp.open('/home/user/live.bin', 'a');
  await fh.write(enc.encode('+more'));
  await fh.close();
  assert.equal(await live('home/user/live.bin'), 'fresh!+more');
}

// FileHandle.truncate + fs.promises.truncate hit the live boundary chunk
{
  const fh = await fsp.open('/home/user/live.bin', 'r+');
  await fh.truncate(5);
  await fh.close();
  assert.equal(await live('home/user/live.bin'), 'fresh');
  await fsp.truncate('/home/user/live.bin', 2);
  assert.equal(await live('home/user/live.bin'), 'fr');
  await assert.rejects(fsp.truncate('/home/user/never.bin', 1), /ENOENT/);
}

// A resident snapshot is only a sync-read cache. If authority changed after
// startup, appendFile must preserve the live prefix rather than publish the
// stale bundle cell as a complete replacement.
{
  await authority.peer.writeFile('home/user/log.txt', 'line1\n');
  await fsp.appendFile('/home/user/log.txt', 'line2\n');
  assert.equal(await live('home/user/log.txt'), 'line1\nline2\n');
  await fsp.appendFile('/home/user/log.txt', 'line3\n');
  assert.equal(
    await live('home/user/log.txt'),
    'line1\nline2\nline3\n',
    'later append chains remain deltas after the stale snapshot is discarded',
  );
  // and async reads see the merged live content
  assert.equal(await fsp.readFile('/home/user/log.txt', 'utf8'), 'line1\nline2\nline3\n');
}

// A sync write the process decided on its view, where that view (no barrier
// since) still says the name is free, is ordered as of that view: before the
// peer's file, which replaced it, as a peer's create after it would on Linux.
// The peer's file stays, nothing is reported, and the append after, which
// waits, is decided on the session as it is now: the peer's file, appended.
{
  await authority.peer.writeFile('home/user/pending-full.txt', 'external\n');
  fs.writeFileSync('/home/user/pending-full.txt', 'replacement\n');
  await fsp.appendFile('/home/user/pending-full.txt', 'tail\n');
  assert.equal(await live('home/user/pending-full.txt'), 'external\ntail\n');
}

// writeFile + appendFile flow (probe parity: WRITE=ok path)
{
  await fsp.writeFile('/home/user/out.txt', 'live-write-ok\n');
  await fsp.appendFile('/home/user/out.txt', 'append-ok\n');
  assert.equal(await live('home/user/out.txt'), 'live-write-ok\nappend-ok\n');
}

// exclusive create
await assert.rejects(fsp.open('/home/user/out.txt', 'wx'), /EEXIST/);

// open with create on missing file creates it live
{
  const fh = await fsp.open('/home/user/made.txt', 'w');
  await fh.writeFile('content');
  await fh.close();
  assert.equal(await live('home/user/made.txt'), 'content');
}

// Range writes through a FileHandle reach the session as positional writes at
// their offset, not as a whole-file rewrite: a small write inside a large file is
// one positional record at its offset, and the file keeps its size.
{
  const CHUNK = 65536;
  await authority.peer.writeFile('home/user/huge.bin', new Uint8Array(CHUNK * 2).fill(7));
  const before = positional.length;
  const fh = await fsp.open('/home/user/huge.bin', 'r+');
  await fh.write(enc.encode('!!'), 0, 2, CHUNK + 1); // inside chunk 1 only
  await fh.close();
  const sent = positional.slice(before).filter((call) => call.path === 'home/user/huge.bin');
  assert.equal(sent.length, 1, 'a small FileHandle positional write is one positional record');
  assert.equal(sent[0].offset, CHUNK + 1, 'at its offset');
  assert.equal(sent[0].size, 2, 'and carries only its own bytes');
  assert.equal((await authority.peer.stat('home/user/huge.bin')).size, CHUNK * 2, 'and it leaves the file its size');
}

console.log('node-shims-live-fs-range: all assertions passed');
