#!/usr/bin/env bun
// git/pack/mount-writer.ts against git's own write paths, through a file API
// that records its calls and fails where told:
//   - writeEntry (entry.c write_entry): the old entry unlinked, then created
//     exclusively with the entry's mode, written whole, closed; a create or
//     write that fails is git's "error: unable to create file" / "unable to
//     write file", then "fatal: unable to checkout working tree", the file
//     closed;
//   - writeLockedIndex (lockfile.c): index.lock created exclusively, written,
//     closed, renamed over the index; one there already is git's "Unable to
//     create '….lock': File exists." with its advice; a write that fails
//     removes our own lock, and is "fatal: unable to write new index file";
//   - mountWriter: the index of any size goes that way; a file within a
//     wave's limit goes in the wave;
//   - withinDeadline: a write that crosses the phase's deadline still
//     reaches its close (and a lock's removal), while nothing else starts.

import assert from 'node:assert/strict';

import { GitWriteFailure, mountWriter, withinDeadline, writeEntry, writeLockedIndex } from '../../packages/worker/src/git/pack/mount-writer.ts';

const enc = new TextEncoder();
const fsError = (code, path) => Object.assign(new Error(`${code}: ${path}`), { code });

/** A file API over a map, its calls recorded; `fail(call, args)` answers an error to throw, or nothing. */
function fakeApi(fail = () => undefined, files = new Map()) {
  const calls = [];
  const open = new Map();
  let next = 1;
  const api = {
    calls, files,
    async mkdir(path) { calls.push(['mkdir', path]); },
    async unlink(path) {
      calls.push(['unlink', path]);
      const error = fail('unlink', [path]);
      if (error) throw error;
      if (!files.has(path)) throw fsError('ENOENT', path);
      files.delete(path);
    },
    async fsOpen(path, flags) {
      calls.push(['fsOpen', path, flags]);
      const error = fail('fsOpen', [path, flags]);
      if (error) throw error;
      if (flags.exclusive && files.has(path)) throw fsError('EEXIST', path);
      files.set(path, { bytes: new Uint8Array(0), mode: flags.mode });
      open.set(next, path);
      return { id: next++ };
    },
    async fsWrite(id, offset, bytes) {
      calls.push(['fsWrite', id, offset, bytes.byteLength]);
      const error = fail('fsWrite', [id, offset, bytes]);
      if (error) throw error;
      const file = files.get(open.get(id));
      const grown = new Uint8Array(Math.max(file.bytes.byteLength, offset + bytes.byteLength));
      grown.set(file.bytes);
      grown.set(bytes, offset);
      file.bytes = grown;
      return bytes.byteLength;
    },
    async fsFstat(id) {
      calls.push(['fsFstat', id]);
      return { ino: id, mode: files.get(open.get(id)).mode, size: files.get(open.get(id)).bytes.byteLength, mtimeMs: 1, ctimeMs: 1, uid: 0, gid: 0, dev: 9 };
    },
    async fsClose(id) { calls.push(['fsClose', id]); open.delete(id); },
    async rename(from, to) {
      calls.push(['rename', from, to]);
      const error = fail('rename', [from, to]);
      if (error) throw error;
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
  return api;
}

const big = new Uint8Array(3 * 1024 * 1024 + 7).fill(7);

// ── writeEntry ──
{
  const api = fakeApi(() => undefined, new Map([['/r/a.bin', { bytes: enc.encode('old'), mode: 0o644 }]]));
  const stat = await writeEntry(api, '/r/a.bin', 'a.bin', 0o755, big);
  assert.equal(stat.size, big.byteLength);
  assert.deepEqual(api.calls.slice(0, 3).map((call) => call[0]), ['mkdir', 'unlink', 'fsOpen'], 'its directory made, the old entry unlinked, then created');
  assert.deepEqual(api.calls[2][2], { write: true, create: true, exclusive: true, mode: 0o755 }, 'exclusively, with its mode');
  assert.deepEqual(api.files.get('/r/a.bin').bytes, big);
  assert.equal(api.calls.at(-1)[0], 'fsClose');
  console.log('  ok  writeEntry: unlinked, created exclusively with its mode, written whole, closed');
}
{
  const failing = fakeApi((call, [, offset]) => (call === 'fsWrite' && offset > 0 ? fsError('EFBIG', 'w') : undefined));
  await assert.rejects(writeEntry(failing, '/r/b.bin', 'dir/b.bin', 0o644, big), (error) => error instanceof GitWriteFailure
    && error.lines === 'error: unable to write file dir/b.bin\nfatal: unable to checkout working tree\n');
  assert.equal(failing.calls.at(-1)[0], 'fsClose', 'the file is closed');
  const uncreated = fakeApi((call) => (call === 'fsOpen' ? fsError('EACCES', 'o') : undefined));
  await assert.rejects(writeEntry(uncreated, '/r/c.bin', 'c.bin', 0o644, big), (error) => error instanceof GitWriteFailure
    && error.lines === 'error: unable to create file c.bin: Permission denied\nfatal: unable to checkout working tree\n');
  console.log('  ok  writeEntry: a write or a create that fails is git\'s error, and the checkout fails');
}

// ── writeLockedIndex ──
{
  const api = fakeApi();
  await writeLockedIndex(api, '/r/.git/index', enc.encode('DIRC'));
  assert.deepEqual(api.calls.map((call) => call[0]), ['fsOpen', 'fsWrite', 'fsFstat', 'fsClose', 'rename']);
  assert.equal(api.calls[0][1], '/r/.git/index.lock');
  assert.equal(api.calls[0][2].exclusive, true);
  assert.deepEqual([...api.files.keys()], ['/r/.git/index']);
  const locked = fakeApi(() => undefined, new Map([['/r/.git/index.lock', { bytes: new Uint8Array(0), mode: 0o644 }]]));
  await assert.rejects(writeLockedIndex(locked, '/r/.git/index', enc.encode('DIRC')), (error) => error instanceof GitWriteFailure
    && error.lines === "fatal: Unable to create '/r/.git/index.lock': File exists.\n\n"
      + 'Another git process seems to be running in this repository, e.g.\n'
      + "an editor opened by 'git commit'. Please make sure all processes\n"
      + 'are terminated then try again. If it still fails, a git process\n'
      + 'may have crashed in this repository earlier:\n'
      + 'remove the file manually to continue.\n');
  assert.ok(locked.files.has('/r/.git/index.lock'), 'another\'s lock is left alone');
  const interrupted = fakeApi((call) => (call === 'fsWrite' ? fsError('ENOSPC', 'w') : undefined));
  await assert.rejects(writeLockedIndex(interrupted, '/r/.git/index', enc.encode('DIRC')), (error) => error instanceof GitWriteFailure
    && error.lines === 'fatal: unable to write new index file\n');
  assert.deepEqual([...interrupted.files.keys()], [], 'our own lock is removed');
  console.log('  ok  writeLockedIndex: lock, write, close, rename; another\'s lock is git\'s "Unable to create"; ours removed when interrupted');
}

// ── mountWriter: the index of any size by its lock; a small file in the wave ──
{
  const api = fakeApi();
  const waved = [];
  const writer = mountWriter({
    async file(path, mode, bytes) { waved.push(path); },
    async symlink() {}, async directory() {}, async remove() {}, async setPin() {}, async flush() {},
  }, api, '/mnt/r');
  await writer.file('.git/index', 0o644, enc.encode('DIRC small'));
  await writer.file('src/a.txt', 0o644, enc.encode('small'));
  assert.deepEqual(waved, ['src/a.txt'], 'a small file goes in the wave');
  assert.deepEqual([...api.files.keys()], ['/mnt/r/.git/index'], 'a small index by its lock');
  console.log('  ok  mountWriter: the index of any size by its lock, a small file in the wave');
}

// ── withinDeadline: a write crossing the deadline still closes ──
{
  let deadline = Date.now() + 60_000;
  const api = fakeApi((call, [, offset]) => {
    // The second piece's write runs past the deadline (it is answered after it).
    if (call === 'fsWrite' && offset > 0) deadline = Date.now() - 1;
    return undefined;
  });
  const bounded = withinDeadline(api, { valueOf: () => deadline });
  await assert.rejects(writeEntry(bounded, '/r/d.bin', 'd.bin', 0o644, big), (error) => error instanceof GitWriteFailure);
  assert.equal(api.calls.at(-1)[0], 'fsClose', 'its close reached the file API past the deadline');
  assert.equal(api.calls.filter((call) => call[0] === 'fsWrite').length, 2, 'and no write started after it');
  console.log('  ok  withinDeadline: a write crossing the deadline still reaches its close');
}
console.log('git-mount-writer: ok');
