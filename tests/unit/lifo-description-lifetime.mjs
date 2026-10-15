#!/usr/bin/env bun
// A command that opens a file holds that one description for as long as it
// uses the file, reads it to a zero-byte read (its end), and closes it on
// every way out, as cat, tee and dd do on Linux:
//
//   - a read that answers fewer bytes than asked is not the end (a mount that
//     reads 4 KiB at a time);
//   - the bytes are the file the open found, whatever takes its name later,
//     from the first byte; dd truncates the file it opened;
//   - tee and dd close every description they opened when a sync, a write,
//     a read, a truncate or their own error report fails.
//
// The commands run in one persistent shell, whose descriptions outlive a
// command, so a leak shows. The mount at /m counts the files it holds open.
//
// Red before: a short read was taken as the end; a file read by name first
// and by a description after could be two files; dd truncated by name after
// its open; a failed sync, write, truncate or report skipped a close.

import assert from 'node:assert/strict';
import { NimbusWorkspace } from '../../packages/core/src/workspace/nimbus-workspace.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { ProcessFile, ProcessView, withOpenFiles } from '../../packages/core/src/runtime/process-files.ts';
import { syscallError } from '../../packages/core/src/vfs/vfs-error.ts';
import { hostSqlite } from './lib/host-sqlite.mjs';

const eio = (what) => Object.assign(new Error(`EIO: i/o error, ${what}`), { code: 'EIO' });
const base = (path) => path.slice(path.lastIndexOf('/') + 1);

/** A mount that holds files open (VFS.openFile), counting them; a file's name says how it misbehaves. */
class Backend extends MemoryVFS {
  held = 0;
  failWriteBack = false;
  openFile(path, rights) {
    void rights;
    const name = base(path);
    this.held++;
    let open = true;
    return {
      path: () => path,
      stat: () => this.stat(path),
      // short-*: at most 4 KiB a read, as a backend may answer.
      read: (offset, length) => this.readRange(path, offset, name.startsWith('short') ? Math.min(length, 4096) : length),
      write: (offset, bytes) => {
        if (name.startsWith('badwrite') || name === 'err') throw eio(`write '${path}'`);
        // nosync-*: writes are held by the description, and the flush that writes them back fails.
        if (name.startsWith('nosync')) throw syscallError('ENOTSUP', 'write', path);
        const old = this.readFile(path);
        const next = new Uint8Array(Math.max(old.length, offset + bytes.length));
        next.set(old);
        next.set(bytes, offset);
        super.writeFile(path, next);
      },
      truncate: (size) => {
        if (name.startsWith('notrunc')) throw eio(`truncate '${path}'`);
        super.writeFile(path, this.readFile(path).slice(0, size));
      },
      close: () => {
        if (open) this.held--;
        open = false;
      },
    };
  }
  writeFile(path, data, options) {
    if (this.failWriteBack && base(path).startsWith('nosync')) throw eio(`write '${path}'`);
    return super.writeFile(path, data, options);
  }
  // grows-*: a stat answers the size the file had, and the file has grown since (another writer).
  stat(path, options) {
    const stat = super.stat(path, options);
    return stat !== null && base(path).startsWith('grows') ? { ...stat, size: 10 } : stat;
  }
}

/** The same backend, answering every call later, as a mount across RPC does: it has no synchronous face. */
class AsyncBackend extends Backend {
  sync = undefined;
  async stat(path, options) { return super.stat(path, options); }
  async readFile(path) { return super.readFile(path); }
  async readRange(path, offset, length) { return super.readRange(path, offset, length); }
  async readdir(path) { return super.readdir(path); }
  async lstat(path) { return super.lstat(path); }
}

const { sql, transactions } = await hostSqlite();
const ws = await NimbusWorkspace.create({ sql, transactions, generation: 1 });
const backend = new Backend({ uid: 1000, gid: 1000 });
ws.filesystem.vfs.mount('/m', backend);
const later = new AsyncBackend({ uid: 1000, gid: 1000 });
ws.filesystem.vfs.mount('/a', later);
const sh = async (line) => {
  const r = await ws.exec(line, { shellId: 'persistent', cwd: '/home/user' });
  return { code: r.exitCode, out: r.stdout, err: r.stderr };
};
const bytes = (n, seed) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);
const text = (data) => new TextDecoder('latin1').decode(data);

try {
  // ── a short read is not the end ─────────────────────────────────────────
  const big = bytes(100_000, 7);
  backend.writeFile('/short-big', big);
  const short = await sh('cat /m/short-big | wc -c');
  assert.equal(short.out.trim(), '100000', 'cat reads a file that answers 4 KiB a read to its end');
  assert.equal(backend.held, 0, 'and closes it');
  console.log('  ✓ a read shorter than asked is read on, to a zero-byte read');

  // ── the file the open found, from the first byte ───────────────────────
  const small = 'small file\n';
  const large = text(bytes(200_000, 3));
  await ws.fs.writeFile('/home/user/swapped', small);
  await ws.fs.writeFile('/home/user/large', large);
  let swap = async () => {};
  const swapOnce = () => {
    const pending = swap;
    swap = async () => {};
    return pending();
  };
  swap = async () => { await ws.fs.rename('/home/user/large', '/home/user/swapped'); };
  const readRange = ProcessView.prototype.readRange;
  const read = ProcessFile.prototype.read;
  ProcessView.prototype.readRange = async function (...args) { await swapOnce(); return readRange.apply(this, args); };
  ProcessFile.prototype.read = async function (...args) { await swapOnce(); return read.apply(this, args); };
  let seen;
  try {
    seen = (await sh('cat /home/user/swapped > /home/user/seen')).code;
  } finally {
    ProcessView.prototype.readRange = readRange;
    ProcessFile.prototype.read = read;
  }
  assert.equal(seen, 0);
  const copy = await ws.fs.readFileString('/home/user/seen');
  assert.ok(copy === small || copy === large, `cat's output is one file whole, not ${copy.length} bytes of two`);
  console.log('  ✓ a file replaced before its first read is read as one file, whole');

  // ── dd truncates the file it opened ────────────────────────────────────
  await ws.fs.writeFile('/home/user/in', 'new');
  await ws.fs.writeFile('/home/user/out', 'old content, longer than the new');
  const truncateByName = ProcessView.prototype.truncate;
  const truncateOpen = ProcessFile.prototype.truncate;
  const moveAway = async () => {
    await ws.fs.rename('/home/user/out', '/home/user/out.moved');
    await ws.fs.writeFile('/home/user/out', 'replacement');
  };
  ProcessView.prototype.truncate = async function (...args) { await moveAway(); return truncateByName.apply(this, args); };
  if (truncateOpen) ProcessFile.prototype.truncate = async function (...args) { await moveAway(); return truncateOpen.apply(this, args); };
  let dd;
  try {
    dd = await sh('dd if=/home/user/in of=/home/user/out status=none');
  } finally {
    ProcessView.prototype.truncate = truncateByName;
    if (truncateOpen) ProcessFile.prototype.truncate = truncateOpen;
  }
  assert.equal(dd.code, 0, dd.err);
  assert.deepEqual([await ws.fs.readFileString('/home/user/out.moved'), await ws.fs.readFileString('/home/user/out')], ['new', 'replacement'],
    'dd truncates and writes the file it opened; what took the name is left as it was');
  console.log('  ✓ dd truncates the file it opened, not what took its name after');

  // ── every description closed, whatever fails ───────────────────────────
  for (const name of ['nosync-a', 'nosync-b', 'badwrite-c', 'err']) backend.writeFile(`/${name}`, new Uint8Array());
  backend.failWriteBack = true;
  const synced = await sh('echo data | tee /m/nosync-a /m/nosync-b /home/user/plain');
  assert.equal(synced.code, 1, 'a failed sync fails tee');
  assert.equal(backend.held, 0, 'tee closed both outputs whose sync failed');
  const reported = await sh('echo data | tee /m/badwrite-c /m/nosync-a /home/user/plain 2>/m/err');
  assert.notEqual(reported.code, 0);
  assert.equal(backend.held, 0, 'tee closed every output though its own report failed');
  console.log('  ✓ tee closes every output when a sync, a write or its own report fails');

  backend.writeFile('/notrunc-x', Uint8Array.of(1, 2, 3));
  const prepared = await sh('dd if=/home/user/in of=/m/notrunc-x status=none');
  assert.equal(prepared.code, 1, 'a truncate that fails fails dd');
  assert.equal(backend.held, 0, 'and dd closed the output it opened');
  const piped = await sh('echo data | dd of=/m/badwrite-c status=none');
  assert.equal(piped.code, 1, 'a write that fails fails dd');
  assert.equal(backend.held, 0, 'and dd closed the output it was copying standard input to');
  console.log('  ✓ dd closes its output when its preparation or a write fails');

  // ── a whole read is bounded on every route ─────────────────────────────
  const grown = bytes(100_000, 11);
  backend.writeFile('/grows-s', grown);
  later.writeFile('/grows-a', grown);
  const view = ws.filesystem.view({ pid: 4242, cred: { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 } });
  for (const path of ['/m/grows-s', '/a/grows-a']) {
    await assert.rejects(view.readFile(path, { maxBytes: 65536 }), (error) => error.code === 'EFBIG',
      `${path}: a whole read of a file grown past its stat is refused, not answered at its new size`);
    const whole = await sh(`cat ${path} | wc -c`);
    assert.equal(whole.out.trim(), '100000', `${path}: cat reads it all, through a description`);
  }
  console.log('  ✓ a whole read refuses a file grown past its stat, synchronous and awaited mounts alike');

  // ── one report a failure, and every description closed ─────────────────
  backend.writeFile('/badwrite-d', new Uint8Array());
  const once = await sh('echo data | tee /m/badwrite-d /home/user/plain');
  assert.equal(once.code, 1);
  assert.equal(once.err.split('badwrite-d').length - 1, 1, `tee reports a FILE it could not write once: ${JSON.stringify(once.err)}`);
  assert.equal(backend.held, 0);
  backend.failWriteBack = false;
  for (const name of ['nosync-e', 'nosync-f']) backend.writeFile(`/${name}`, new Uint8Array());
  backend.failWriteBack = true;
  await withOpenFiles(view, async (open) => {
    for (const name of ['nosync-e', 'nosync-f']) await (await open(`/m/${name}`, { write: true, create: true, truncate: true })).write(Uint8Array.of(1));
  }, () => { throw new Error('the report could not be made'); });
  assert.equal(backend.held, 0, 'a reporter that throws at once leaves no description open');
  console.log('  ✓ a FILE tee closed is reported once and not synced again; a throwing reporter leaves none open');
} finally {
  await ws.close();
}
console.log('lifo-description-lifetime: ok');
