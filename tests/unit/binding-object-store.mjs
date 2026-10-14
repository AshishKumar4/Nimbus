#!/usr/bin/env bun
// binding-object-store — `nimbus wrangler dev`'s KV and R2 stores keep each
// object as a body file and a `.meta` sidecar under
// `<root>/.nimbus/<kv|r2>/<binding>/`, on the session's real filesystem
// (SqliteVFS, as the session's user, which resolves `.` and `..`). Driven
// through each store's API:
//
//   - keys that need encoding round-trip, a listing pages in key order to
//     its end, a delete leaves no file behind, KV expiry hides a key, R2
//     groups keys by a delimiter, an empty body streams;
//   - no key or binding name reaches outside its binding's directory: `.`,
//     `..` and `../..` are names in it, and a key ending `.meta` is not
//     another key's sidecar;
//   - a body read after its get answered (a stream the Worker reads later)
//     waits for another holder's delegation over it to be recalled, as a
//     call the session serves does, and errors if the recall changed it;
//   - a body is streamed to its file as it arrives, never held whole: the
//     store writes each piece before it asks for the next; a body past the
//     platform's limit (25 MiB for a KV value, R2's per-upload limit) is
//     refused with the platform's error once the limit is passed, its
//     stream cancelled rather than drained, and nothing is stored; an R2
//     body that fails its checksum or condition leaves the old object;
//   - R2 options that are not R2's (a non-string metadata value) are
//     refused before anything is stored, rather than stored unreadable;
//   - a KV bulk JSON read of a stored null answers null, and a KV listing
//     limit that is not positive is the default.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SqliteVFS } from '../../packages/core/src/vfs/sqlite-vfs.ts';
import { CRED_KERNEL, CRED_SESSION_USER } from '../../packages/core/src/runtime/os-contracts.ts';
import { KvEmulator, _setKvNow, serveKvCall } from '../../packages/worker/src/bindings/kv.ts';
import { R2Emulator, serveR2Call } from '../../packages/worker/src/bindings/r2.ts';
import { createSqliteVfsTestHarness } from './lib/sqlite-vfs-test-harness.mjs';

const MiB = 1024 * 1024;

/** The session's filesystem (`raw`, the engine), as the session's user, with a project at home/user/app. */
function sessionVfs() {
  const harness = createSqliteVfsTestHarness();
  const raw = new SqliteVFS(harness.sql, harness.ctx);
  const kernel = raw.as(CRED_KERNEL);
  kernel.mkdir('home/user/app', { recursive: true });
  kernel.chown('home/user', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  kernel.chown('home/user/app', CRED_SESSION_USER.uid, CRED_SESSION_USER.gid);
  return { raw, fs: raw.as(CRED_SESSION_USER) };
}
const sessionFs = () => sessionVfs().fs;

/**
 * Another process's delegation of `root`, covering reads: a read under it
 * waits for `recall`, which does what the holder decided (`decide`, as the
 * holder) and is counted.
 */
function delegate(raw, root, decide = () => {}) {
  const recalls = [];
  let owned;
  const lease = raw.acquireExclusiveMutation(root, {
    delegation: {
      reads: true,
      async recall(kind) {
        recalls.push(kind);
        await new Promise((resolve) => setTimeout(resolve, 2));
        decide(owned);
      },
    },
  });
  owned = raw.as(CRED_KERNEL, { mutationOwner: lease.owner });
  return recalls;
}

/** Every file under `dir`, as paths relative to it, depth first. */
function filesUnder(fs, dir) {
  const out = [];
  const walk = (at) => {
    for (const { name, type } of fs.readdir(at)) {
      if (type === 'directory') walk(`${at}/${name}`);
      else out.push(`${at}/${name}`.slice(dir.length + 1));
    }
  };
  if (fs.exists(dir)) walk(dir);
  return out.sort();
}

/** A stream of `total` bytes in `piece`-byte chunks, made as they are asked for; it counts what was asked and whether it was cancelled. */
function lazyStream(total, piece = 64 * 1024) {
  const state = { pulled: 0, cancelled: false, stream: null };
  state.stream = new ReadableStream({
    pull(controller) {
      if (state.pulled >= total) { controller.close(); return; }
      const size = Math.min(piece, total - state.pulled);
      const chunk = new Uint8Array(size);
      for (let i = 0; i < size; i++) chunk[i] = (state.pulled + i) & 0xff;
      state.pulled += size;
      controller.enqueue(chunk);
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return state;
}

const text = (stream) => new Response(stream).text();
const KEYS = ['a/b c', 'a/b%d', 'b#1', 'a/ü'];

// ── KV ───────────────────────────────────────────────────────────────────────
{
  const fs = sessionFs();
  const kv = new KvEmulator({ vfs: fs, root: '/home/user/app/', binding: 'CACHE' });
  assert.equal(await kv.list().then((r) => r.keys.length), 0, 'a binding with nothing stored lists nothing');
  for (const key of KEYS) await kv.put(key, `value of ${key}`, { metadata: { key } });
  for (const key of KEYS) {
    assert.equal(await kv.get(key), `value of ${key}`);
    assert.deepEqual((await kv.getWithMetadata(key)).metadata, { key });
  }

  const pages = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: 'a/', limit: 2, cursor });
    pages.push(page.keys.map((k) => k.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  assert.deepEqual(pages, [['a/b c', 'a/b%d'], ['a/ü']], 'a prefix listing pages in key order to its end');
  for (const limit of [0, -1]) {
    assert.equal((await kv.list({ prefix: 'a/', limit })).keys.length, 3, `a limit of ${limit} is the default, as workerd's client sends none`);
  }

  await kv.delete('a/b c');
  assert.equal(await kv.get('a/b c'), null);
  assert.ok(!filesUnder(fs, 'home/user/app/.nimbus/kv/CACHE').some((p) => p.startsWith(encodeURIComponent('a/b c'))), 'a delete removes the body and its sidecar');

  _setKvNow(() => 1_000);
  await kv.put('ttl', 'soon gone', { expirationTtl: 60 });
  assert.equal(await kv.get('ttl'), 'soon gone');
  _setKvNow(() => 1_060);
  assert.equal(await kv.get('ttl'), null, 'an expired key reads as absent');
  assert.ok(!(await kv.list()).keys.some((k) => k.name === 'ttl'), 'an expired key is not listed');
  _setKvNow(() => Math.floor(Date.now() / 1000));
  await kv.put('empty', '');
  assert.equal(await text(await kv.get('empty', { type: 'stream' })), '', 'an empty value streams as no bytes');

  // A stored JSON null, read in bulk as JSON with metadata, is null (Miniflare's processKeyValue).
  await kv.put('jnull', 'null', { metadata: { m: 1 } });
  assert.deepEqual([...await kv.getWithMetadata(['jnull', 'missing'], 'json')], [['jnull', null], ['missing', null]],
    'a JSON null is null in a bulk read with metadata');
}

// ── A KV value streams to its file, and one past 25 MiB is refused as it passes ──
{
  const fs = sessionFs();
  const kv = new KvEmulator({ vfs: fs, root: 'home/user/app', binding: 'CACHE' });
  const fine = lazyStream(3 * MiB + 17);
  await kv.put('streamed', fine.stream);
  assert.equal(fs.stat('home/user/app/.nimbus/kv/CACHE/streamed').size, 3 * MiB + 17, 'a streamed value is stored whole');

  const big = lazyStream(64 * MiB);
  await assert.rejects(kv.put('big', big.stream), (error) => /^KV PUT failed: 413 Value length of \d+ exceeds limit of 26214400\.$/.test(error.message));
  assert.ok(big.cancelled, 'the stream is cancelled, not drained');
  assert.ok(big.pulled <= 25 * MiB + 64 * 1024, `no more than the limit and one piece is read (${big.pulled} bytes)`);
  assert.equal(await kv.get('big'), null, 'nothing is stored');
  assert.deepEqual(filesUnder(fs, 'home/user/app/.nimbus/kv/CACHE'), ['streamed'], 'and nothing is left behind');
  // A whole value is refused by its length, before it is written.
  await assert.rejects(kv.put('big', new Uint8Array(25 * MiB + 1)), { message: 'KV PUT failed: 413 Value length of 26214401 exceeds limit of 26214400.' });
}

// ── R2 ───────────────────────────────────────────────────────────────────────
{
  const fs = sessionFs();
  const r2 = new R2Emulator({ vfs: fs, root: 'home/user/app', binding: 'BUCKET' });
  for (const key of KEYS) await r2.put(key, `body of ${key}`, {});
  assert.equal(await text((await r2.get('b#1', {})).body), 'body of b#1', 'the body streams its bytes');

  const pages = [];
  let cursor;
  do {
    const page = await r2.list({ limit: 2, cursor });
    pages.push(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  assert.deepEqual(pages, [['a/b c', 'a/b%d'], ['a/ü', 'b#1']], 'a listing pages in key order to its end');

  const grouped = await r2.list({ delimiter: '/' });
  assert.deepEqual(grouped.delimitedPrefixes, ['a/']);
  assert.deepEqual(grouped.objects.map((o) => o.key), ['b#1']);

  await r2.delete(['a/b c']);
  assert.equal(await r2.head('a/b c'), null);
  assert.deepEqual((await r2.list({})).objects.map((o) => o.key), ['a/b%d', 'a/ü', 'b#1']);
  assert.equal(filesUnder(fs, 'home/user/app/.nimbus/r2/BUCKET').length, 6, 'a delete removes the body and its sidecar');

  // An empty body streams as no bytes (a byte stream refuses an empty chunk).
  await r2.put('empty', null, {});
  assert.equal(await text((await r2.get('empty', {})).body), '');
  await r2.delete('empty');
}

// ── No key and no binding name reaches outside its binding's directory ───────
{
  const fs = sessionFs();
  const r2 = new R2Emulator({ vfs: fs, root: 'home/user/app', binding: 'BUCKET' });
  for (const key of ['.', '..', '../..', '../../x']) await r2.put(key, `body of ${key}`, {});
  for (const key of ['.', '..', '../..', '../../x']) {
    assert.equal(await text((await r2.get(key, {})).body), `body of ${key}`, `${key} reads back`);
  }
  assert.deepEqual((await r2.list({ prefix: '.' })).objects.map((o) => o.key), ['.', '..', '../..', '../../x']);
  assert.equal(filesUnder(fs, 'home/user/app/.nimbus/r2/BUCKET').length, 8, 'each dot key is a file of the bucket');
  assert.deepEqual(filesUnder(fs, 'home/user/app').filter((p) => !p.startsWith('.nimbus/r2/BUCKET/')), [], 'and nothing is outside it');

  // A key ending `.meta` is its own object, not another key's sidecar.
  await r2.put('a', 'body of a', { customMetadata: { who: 'a' } });
  await r2.put('a.meta', 'body of a.meta', {});
  assert.deepEqual((await r2.head('a')).customMetadata, { who: 'a' }, 'a.meta does not overwrite the sidecar of a');
  assert.equal(await text((await r2.get('a.meta', {})).body), 'body of a.meta');
  assert.deepEqual((await r2.list({ prefix: 'a' })).objects.map((o) => o.key), ['a', 'a.meta']);

  const kv = new KvEmulator({ vfs: fs, root: 'home/user/app', binding: '../../escape' });
  await kv.put('k', 'v');
  const escaped = new R2Emulator({ vfs: fs, root: 'home/user/app', binding: '..' });
  await escaped.put('k', 'v', {});
  assert.deepEqual(filesUnder(fs, 'home/user/app').filter((p) => !p.startsWith('.nimbus/r2/BUCKET/')),
    ['.nimbus/kv/..%2F..%2Fescape/k', '.nimbus/r2/%2E%2E/k', '.nimbus/r2/%2E%2E/k.meta'], 'a binding name is one directory of its kind');
}

// ── An R2 body streams to its file; past the per-upload limit it is refused as it passes ──
{
  const fs = sessionFs();
  const r2 = new R2Emulator({ vfs: fs, root: 'home/user/app', binding: 'BUCKET', maxUploadBytes: 4 * MiB });
  const fine = lazyStream(3 * MiB + 5);
  const expected = createHash('md5');
  for (let at = 0; at < 3 * MiB + 5; at += 64 * 1024) {
    const size = Math.min(64 * 1024, 3 * MiB + 5 - at);
    expected.update(Uint8Array.from({ length: size }, (_, i) => (at + i) & 0xff));
  }
  const put = await r2.put('big.bin', fine.stream, {});
  assert.equal(put.size, 3 * MiB + 5);
  assert.equal(put.etag, expected.digest('hex'), 'its MD5 is computed as it streams');
  const read = await r2.get('big.bin', { range: { offset: MiB, length: 10 } });
  assert.deepEqual([...new Uint8Array(await new Response(read.body).arrayBuffer())], Array.from({ length: 10 }, (_, i) => (MiB + i) & 0xff), 'a range reads its bytes');

  const big = lazyStream(64 * MiB);
  await assert.rejects(r2.put('big.bin', big.stream, {}), { message: 'put: Your proposed upload exceeds the maximum allowed object size. (100100)' });
  assert.ok(big.cancelled, 'the stream is cancelled, not drained');
  assert.ok(big.pulled <= 4 * MiB + 64 * 1024, `no more than the limit and one piece is read (${big.pulled} bytes)`);
  assert.equal((await r2.head('big.bin')).size, 3 * MiB + 5, 'the object it would have replaced is kept');

  // A checksum or a condition that fails after the body is read keeps the old object, and leaves no file behind.
  await assert.rejects(r2.put('big.bin', 'other', { checksums: { md5: '0'.repeat(32) } }), /^Error: put: The MD5 checksum you specified did not match/);
  assert.equal(await r2.put('big.bin', 'other', { onlyIf: { etagMatches: [{ type: 'strong', value: 'nope' }] } }), null);
  assert.equal((await r2.head('big.bin')).size, 3 * MiB + 5);
  assert.deepEqual(filesUnder(fs, 'home/user/app/.nimbus/r2/BUCKET'), ['big.bin', 'big.bin.meta'], 'no upload is left behind');

  // Wire options that are not R2's are refused before anything is stored.
  await assert.rejects(serveR2Call(r2, { method: 'put', key: 'm', value: 'v', options: { customMetadata: { count: 1 } } }));
  await assert.rejects(serveR2Call(r2, { method: 'put', key: 'm', value: 'v', options: { httpMetadata: { contentType: 1 } } }));
  assert.equal(await r2.head('m'), null, 'nothing was stored');
  const kv = new KvEmulator({ vfs: fs, root: 'home/user/app', binding: 'CACHE' });
  await assert.rejects(serveKvCall(kv, { method: 'nope', key: 'k' }));
}

// ── A body read later waits for a delegation over it, and is the object it began ──
{
  const size = 3 * MiB + 5;
  const expected = Uint8Array.from({ length: size }, (_, i) => i & 0xff);
  for (const kind of ['R2', 'KV']) {
    const { raw, fs } = sessionVfs();
    const r2 = new R2Emulator({ vfs: fs, root: 'home/user/app', binding: 'BUCKET' });
    const kv = new KvEmulator({ vfs: fs, root: 'home/user/app', binding: 'CACHE' });
    const store = kind === 'R2' ? r2 : kv;
    const read = async () => (kind === 'R2' ? (await r2.get('big.bin', {})).body : await kv.get('big.bin', { type: 'stream' }));
    await store.put('big.bin', lazyStream(size).stream, {});
    // Obtained, then another process delegates the store before a byte is read.
    const later = await read();
    const recalls = delegate(raw, 'home/user/app/.nimbus');
    const bytes = new Uint8Array(await new Response(later).arrayBuffer());
    assert.ok(recalls.length > 0, `${kind}: the read met the delegation`);
    assert.equal(bytes.length, size, `${kind}: the whole body is read once the delegation is recalled`);
    assert.ok(bytes.every((byte, i) => byte === expected[i]), `${kind}: and it is the body`);

    // A recall that replaces the object: the body errors rather than mix two objects.
    const { raw: raw2, fs: fs2 } = sessionVfs();
    const store2 = kind === 'R2' ? new R2Emulator({ vfs: fs2, root: 'home/user/app', binding: 'BUCKET' }) : new KvEmulator({ vfs: fs2, root: 'home/user/app', binding: 'CACHE' });
    await store2.put('big.bin', lazyStream(size).stream, {});
    const stream = kind === 'R2' ? (await store2.get('big.bin', {})).body : await store2.get('big.bin', { type: 'stream' });
    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(first.value.byteLength, MiB, `${kind}: a body is read a piece at a time`);
    const path = `home/user/app/.nimbus/${kind === 'R2' ? 'r2/BUCKET' : 'kv/CACHE'}/big.bin`;
    delegate(raw2, 'home/user/app/.nimbus', (owned) => owned.writeFile(path, 'replaced'));
    await assert.rejects(reader.read(), /the object changed while its body was read/, `${kind}: a body whose object the recall replaced errors`);
  }
}

// ── The store writes each piece before it asks for the next: no body is held whole ──
{
  const fs = sessionFs();
  let held = 0;
  let most = 0;
  // The filesystem as the store sees it, counting what was asked for and not yet written.
  const watched = new Proxy(fs, {
    get(target, name) {
      if (name !== 'writeFileFrom') return Reflect.get(target, name);
      return (path, size, source, options) => target.writeFileFrom(path, size, (async function* () {
        for await (const piece of source) {
          held -= piece.byteLength;
          yield piece;
        }
      })(), options);
    },
  });
  let pulls = 0;
  const counted = new ReadableStream({
    pull(controller) {
      if (++pulls > 200) { controller.close(); return; }
      held += 64 * 1024;
      most = Math.max(most, held);
      controller.enqueue(new Uint8Array(64 * 1024));
    },
  }, { highWaterMark: 0 });
  await new R2Emulator({ vfs: watched, root: 'home/user/app', binding: 'BUCKET' }).put('k', counted, {});
  assert.equal(fs.stat('home/user/app/.nimbus/r2/BUCKET/k').size, 200 * 64 * 1024);
  assert.ok(most <= 64 * 1024, `at most one piece is read ahead of the file (${most} bytes)`);
}

console.log('binding-object-store: ok');
