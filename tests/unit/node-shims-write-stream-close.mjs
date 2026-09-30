#!/usr/bin/env bun
// A guest stream's lifecycle follows Node's order (every expectation below is
// what Node 22 does with the same calls).
//
// - A Writable closes after 'finish' (autoDestroy), so a copy that waits on
//   the destination's 'close' (`src.pipe(fs.createWriteStream(f)).on('close',
//   done)`) completes; a Duplex closes once both of its sides are done.
// - end() waits for every write to call back: an asynchronous _write finishes
//   before 'finish' and 'close', and an asynchronous Transform's output is
//   delivered. end() used to run _final at once, so the Transform's readable
//   side was destroyed before its callback pushed, and its output was lost.
// - Writes run one at a time, the next starting before the previous one's
//   callback; destroy() or a failed write answers every queued write.
// - autoDestroy: false keeps a stream open, emitClose: false destroys it
//   without 'close', and an fs stream reads them from autoClose/emitClose.
import assert from 'node:assert/strict';
import { VFS_WRITE_LEDGER_SOURCE } from '../../packages/core/src/_shared/vfs-write-ledger.ts';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE } from './lib/shims-namespace.mjs';

const factory = new Function('__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', '__pendingIO', 'stdin',
  'let stdout="",stderr="";' + VFS_WRITE_LEDGER_SOURCE + '\n' + SHIMS_STORE_PRELUDE + generateShimsCode() + ';return builtins;');
const SOURCE = 'copied through a pipe — Grüße ✓\n';
const builtins = factory({ 'home/user/site/hello.txt': SOURCE }, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/copy.js', '/home/user', [], '');
const { fs, stream } = builtins;

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`stalled: ${label}`)), ms)),
]);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// ── a copy that waits on the destination's 'close' ─────────────────────────
{
  const copied = new Promise((resolve, reject) => {
    const order = [];
    const out = fs.createWriteStream('/home/user/site/copy.txt');
    out.on('finish', () => order.push('finish'));
    out.on('close', () => { order.push('close'); resolve(order); });
    out.on('error', reject);
    fs.createReadStream('/home/user/site/hello.txt').pipe(out);
  });
  assert.deepEqual(await withTimeout(copied, 5000, "pipe to fs.createWriteStream, waiting on 'close'"), ['finish', 'close']);
  assert.equal(fs.readFileSync('/home/user/site/copy.txt', 'utf8'), SOURCE, 'the file is written when it closes');
}

// ── autoDestroy: false keeps a finished writable open ──────────────────────
{
  const kept = new stream.Writable({ autoDestroy: false, write(chunk, encoding, cb) { cb(); } });
  let closed = false;
  kept.on('close', () => { closed = true; });
  await withTimeout(new Promise((resolve) => kept.end('x', resolve)), 5000, 'autoDestroy: false');
  await settle();
  assert.equal(closed, false, 'a writable that opts out of autoDestroy stays open after finish');
}

// ── a Duplex closes once both sides are done ───────────────────────────────
{
  const events = [];
  const duplex = new stream.Duplex({ read() { this.push(null); }, write(chunk, encoding, cb) { cb(); } });
  for (const name of ['end', 'finish', 'close']) duplex.on(name, () => events.push(name));
  duplex.resume();
  await settle();
  assert.deepEqual(events, ['end'], 'still writable after its readable side ends: open');
  duplex.end();
  await withTimeout(new Promise((resolve) => duplex.on('close', resolve)), 5000, 'Duplex close after both sides');
  assert.deepEqual(events, ['end', 'finish', 'close']);

  const order = [];
  const through = new stream.PassThrough();
  for (const name of ['end', 'finish', 'close']) through.on(name, () => order.push(name));
  through.end('abc');
  await settle();
  assert.deepEqual(order, ['finish'], 'finished writing with its readable side unread: open');
  through.resume();
  await withTimeout(new Promise((resolve) => through.on('close', resolve)), 5000, 'PassThrough close after both sides');
  assert.deepEqual(order, ['finish', 'end', 'close']);
}

// ── end() waits for asynchronous writes ─────────────────────────────────────
{
  const events = [];
  let delivered = '';
  const out = new stream.Writable({
    write(chunk, encoding, cb) {
      setTimeout(() => { delivered += new TextDecoder().decode(chunk); events.push('written'); cb(); }, 15);
    },
  });
  out.on('finish', () => events.push(`finish:${delivered}`));
  out.on('close', () => events.push(`close:${delivered}`));
  out.end('abc');
  await withTimeout(new Promise((resolve) => out.on('close', resolve)), 5000, 'asynchronous write, then close');
  assert.deepEqual(events, ['written', 'finish:abc', 'close:abc'], 'finish and close follow the write');

  const order = [];
  const serial = new stream.Writable({
    write(chunk, encoding, cb) {
      const name = new TextDecoder().decode(chunk);
      order.push(`start:${name}`);
      setTimeout(() => { order.push(`done:${name}`); cb(); }, 5);
    },
  });
  serial.on('finish', () => order.push('finish'));
  serial.write('a', () => order.push('cb:a'));
  serial.write('b', () => order.push('cb:b'));
  serial.end('c', () => order.push('end-cb'));
  await withTimeout(new Promise((resolve) => serial.on('close', resolve)), 5000, 'queued writes');
  assert.deepEqual(order, ['start:a', 'done:a', 'start:b', 'cb:a', 'done:b', 'start:c', 'cb:b', 'done:c', 'end-cb', 'finish'],
    'one write at a time; the next starts before the callback');
}

// ── destroy and errors answer every queued write ────────────────────────────
{
  // One write in flight (its callback held), two queued and end() pending
  // when the stream is destroyed; then a write after it.
  const events = [];
  const held = [];
  const out = new stream.Writable({ write(chunk, encoding, cb) { held.push(cb); } });
  out.on('error', (e) => events.push(`error:${e.code}`));
  out.on('close', () => events.push('close'));
  for (const name of ['a', 'b', 'c']) out.write(name, (e) => events.push(`${name}:${e ? e.code : 'ok'}`));
  out.end((e) => events.push(`end:${e ? e.code : 'ok'}`));
  out.destroy();
  out.write('d', (e) => events.push(`d:${e ? e.code : 'ok'}`));
  await settle();
  events.push('in-flight write calls back');
  held.shift()();
  await settle();
  assert.deepEqual(events, ['close', 'd:ERR_STREAM_WRITE_AFTER_END', 'in-flight write calls back', 'a:ok',
    'b:ERR_STREAM_DESTROYED', 'c:ERR_STREAM_DESTROYED', 'end:ERR_STREAM_DESTROYED'], 'every queued write is answered');

  const failed = [];
  const failing = new stream.Writable({
    write(chunk, encoding, cb) { setTimeout(() => cb(new TextDecoder().decode(chunk) === 'a' ? new Error('boom') : null), 5); },
  });
  failing.on('error', (e) => failed.push(`error:${e.message}`));
  failing.on('close', () => failed.push('close'));
  for (const name of ['a', 'b']) failing.write(name, (e) => failed.push(`${name}:${e ? e.message : 'ok'}`));
  await withTimeout(new Promise((resolve) => failing.on('close', resolve)), 5000, 'a failed write destroys the stream');
  assert.deepEqual(failed, ['a:boom', 'b:boom', 'error:boom', 'close'], 'the queue is answered, then error and close');
}

// ── an asynchronous Transform delivers its output ───────────────────────────
{
  const events = [];
  let data = '';
  const transform = new stream.Transform({
    transform(chunk, encoding, cb) { setTimeout(() => { events.push('transformed'); cb(null, chunk); }, 15); },
  });
  transform.on('data', (chunk) => { data += new TextDecoder().decode(chunk); });
  for (const name of ['end', 'finish', 'close']) transform.on(name, () => events.push(name));
  transform.end('abc');
  await withTimeout(new Promise((resolve) => transform.on('close', resolve)), 5000, 'asynchronous transform');
  assert.equal(data, 'abc', 'the transform output is delivered');
  assert.deepEqual(events, ['transformed', 'end', 'finish', 'close']);
}

// ── emitClose: false, and an fs stream's autoClose / emitClose ──────────────
{
  const lifecycle = async (s, start) => {
    const events = [];
    for (const name of ['end', 'finish', 'close']) s.on(name, () => events.push(name));
    start(s);
    await settle(); await settle();
    const destroyed = (s._readableState ?? s._writableState).destroyed;
    return { events, destroyed };
  };
  const read = (s) => s.resume();
  const write = (s) => s.end('x');
  assert.deepEqual(await lifecycle(new stream.Readable({ emitClose: false, read() { this.push(null); } }), read),
    { events: ['end'], destroyed: true }, 'emitClose: false destroys a readable without close');
  assert.deepEqual(await lifecycle(new stream.Writable({ emitClose: false, write(c, e, cb) { cb(); } }), write),
    { events: ['finish'], destroyed: true }, 'emitClose: false destroys a writable without close');

  const file = '/home/user/site/hello.txt';
  const target = (name) => `/home/user/site/${name}.txt`;
  assert.deepEqual(await lifecycle(fs.createReadStream(file), read), { events: ['end', 'close'], destroyed: true });
  assert.deepEqual(await lifecycle(fs.createReadStream(file, { autoClose: false }), read),
    { events: ['end'], destroyed: false }, 'autoClose: false leaves a read stream open');
  assert.deepEqual(await lifecycle(fs.createReadStream(file, { emitClose: false }), read),
    { events: ['end'], destroyed: true }, 'emitClose: false closes a read stream silently');
  assert.deepEqual(await lifecycle(fs.createWriteStream(target('default')), write), { events: ['finish', 'close'], destroyed: true });
  assert.deepEqual(await lifecycle(fs.createWriteStream(target('kept'), { autoClose: false }), write),
    { events: ['finish'], destroyed: false }, 'autoClose: false leaves a write stream open');
  assert.deepEqual(await lifecycle(fs.createWriteStream(target('silent'), { emitClose: false }), write),
    { events: ['finish'], destroyed: true }, 'emitClose: false closes a write stream silently');
  assert.deepEqual(await lifecycle(new fs.WriteStream(target('class'), { autoClose: false }), write),
    { events: ['finish'], destroyed: false }, 'fs.WriteStream reads autoClose too');
  assert.equal(fs.readFileSync(target('kept'), 'utf8'), 'x');
}

console.log('node-shims-write-stream-close: ok');
