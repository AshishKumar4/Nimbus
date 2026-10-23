#!/usr/bin/env bun
// A guest Readable says whether a consumer owns it in readable mode, as
// Node's flushStdio reads it: still readable, its
// `_readableState.readableListening` set by a 'readable' listener or an async
// iterator that has not completed. A child's stdout/stderr is resumed after
// 'exit' only when nobody owns it (Node's flushStdio, node-shims
// _flushStdio). What has to hold:
//
//   - attaching a 'readable' listener owns it; removing the last one, by
//     off, removeListener or removeAllListeners, or a once listener firing,
//     releases it on the next tick, as Node updates it; while one of two
//     remains, it stays owned;
//   - an async iterator owns it from its first read (next()), as Node's does,
//     until it completes: the stream ends, it errors, or the loop leaves
//     early (return()).
//
// Before (857347754), ownership was set and never cleared: a stream whose
// 'readable' listener had been removed was skipped by the drain, and its
// child's 'close' never came.

import assert from 'node:assert/strict';
import { generateShimsCode } from '../../packages/worker/src/runtime/node-shims.ts';
import { SHIMS_STORE_PRELUDE, SHIMS_STORE_START } from './lib/shims-namespace.mjs';

const factory = new Function('__vfsBundle', '__vfsDirs', '__supervisor', 'cred', 'cwd', 'argv', 'env', 'filename', 'dirname', '__pendingIO', 'stdin',
  'let stdout="",stderr="";' + SHIMS_STORE_PRELUDE + generateShimsCode() + SHIMS_STORE_START + ';return builtins;');
const { stream } = factory({}, {}, null, { uid: 1000, gid: 1000, groups: [1000], umask: 0o022 },
  '/home/user', [], {}, '/home/user/main.js', '/home/user', [], '');
const owned = (s) => s.readable && s._readableState.readableListening;
const text = (chunk) => (typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── 'readable' listeners ────────────────────────────────────────────────────
{
  for (const remove of ['off', 'removeListener', 'removeAllListeners']) {
    const s = new stream.PassThrough();
    const a = () => {};
    const b = () => {};
    assert.equal(owned(s), false, 'a fresh stream is not owned');
    s.on('readable', a);
    s.addListener('readable', b);
    assert.equal(owned(s), true, `a 'readable' listener owns it`);
    if (remove === 'removeAllListeners') {
      s.removeAllListeners('readable');
    } else {
      s[remove]('readable', a);
      assert.equal(owned(s), true, `${remove} of one of two: still owned`);
      s[remove]('readable', b);
    }
    await tick();
    assert.equal(owned(s), false, `${remove} of the last: released`);
  }
  const s = new stream.PassThrough();
  s.on('readable', () => {});
  s.removeAllListeners();
  await tick();
  assert.equal(owned(s), false, 'removeAllListeners() with no event releases it too');
  const once = new stream.PassThrough();
  once.once('readable', () => {});
  assert.equal(owned(once), true, "a once 'readable' listener owns it");
  once.removeAllListeners('readable');
  await tick();
  assert.equal(owned(once), false);
}

// ── async iterators ────────────────────────────────────────────────────────
{
  // Completes when the stream ends.
  const s = new stream.PassThrough();
  const iterator = s[Symbol.asyncIterator]();
  const first = iterator.next();
  assert.equal(owned(s), true, 'an iterator owns it from its first read');
  s.end('x');
  const seen = [];
  for (let r = await first; !r.done; r = await iterator.next()) seen.push(text(r.value));
  assert.deepEqual(seen, ['x']);
  assert.equal(owned(s), false, 'and releases it when the stream ends');

  // Leaves early.
  const early = new stream.PassThrough();
  early.write('a');
  for await (const chunk of early) { assert.equal(text(chunk), 'a'); break; }
  assert.equal(owned(early), false, 'a loop that breaks releases it');

  // Errors.
  const failing = new stream.PassThrough();
  const it = failing[Symbol.asyncIterator]();
  const next = it.next();
  await tick();
  failing.emit('error', new Error('boom'));
  await assert.rejects(next, /boom/);
  assert.equal(owned(failing), false, 'an iterator that errors releases it');
}

console.log("ok - stream-readable-listening ('readable' listeners and async iterators own a stream while they are there, and release it)");
