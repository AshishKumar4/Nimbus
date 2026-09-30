#!/usr/bin/env bun
// A guest Writable closes after 'finish', as Node's autoDestroy has it.
//
// A download or a copy commonly waits on the destination's 'close':
//     src.pipe(fs.createWriteStream(f)).on('close', done)
// The guest's Writable emitted 'finish' and never 'close', so `done` never ran.
// A Duplex closes only once both of its sides are done, and a stream created
// with `autoDestroy: false` stays open.
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

console.log('node-shims-write-stream-close: ok');
