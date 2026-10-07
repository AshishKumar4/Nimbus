#!/usr/bin/env bun
// binding-object-store — `nimbus wrangler dev`'s KV and R2 emulators store
// each object as a body file and a `.meta` sidecar under
// `<root>/.nimbus/<kv|r2>/<binding>/`, and page their listings with an
// offset cursor. Driven through each emulator's Workers API over an
// in-memory filesystem: keys that need encoding round-trip, a listing pages
// in key order to its end, a delete leaves no file behind, KV expiry hides
// a key, and R2 groups keys by a delimiter.

import assert from 'node:assert/strict';
import { KvEmulator, _setKvNow } from '../../packages/worker/src/bindings/kv.ts';
import { R2Emulator } from '../../packages/worker/src/bindings/r2.ts';

/** A CredentialedVfs over a Map: the subset the emulators call. */
function memoryVfs() {
  const files = new Map();
  const dirs = new Set(['']);
  const vfs = {
    files,
    exists: (path) => files.has(path) || dirs.has(path),
    mkdir: (path) => {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    },
    writeFile: (path, data) => {
      files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
    },
    readFile: (path) => {
      if (!files.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return files.get(path);
    },
    readFileString: (path) => new TextDecoder().decode(vfs.readFile(path)),
    unlink: (path) => { files.delete(path); },
    readdir: (dir) => {
      if (!dirs.has(dir)) throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
      const names = new Map();
      for (const path of [...files.keys(), ...dirs]) {
        if (!path.startsWith(`${dir}/`)) continue;
        const name = path.slice(dir.length + 1).split('/')[0];
        names.set(name, dirs.has(`${dir}/${name}`) ? 'directory' : 'file');
      }
      return [...names].map(([name, type]) => ({ name, type }));
    },
  };
  return vfs;
}

const KEYS = ['a/b c', 'a/b%d', 'b#1', 'a/ü'];

// ── KV ───────────────────────────────────────────────────────────────────────
{
  const vfs = memoryVfs();
  const kv = new KvEmulator({ vfs, root: '/home/user/app/', binding: 'CACHE', onLog: () => {} });
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

  await kv.delete('a/b c');
  assert.equal(await kv.get('a/b c'), null);
  assert.deepEqual([...vfs.files.keys()].filter((p) => p.includes(encodeURIComponent('a/b c'))), [],
    'a delete removes the body and its sidecar');

  _setKvNow(() => 1_000);
  await kv.put('ttl', 'soon gone', { expirationTtl: 60 });
  assert.equal(await kv.get('ttl'), 'soon gone');
  _setKvNow(() => 1_060);
  assert.equal(await kv.get('ttl'), null, 'an expired key reads as absent');
  assert.ok(!(await kv.list()).keys.some((k) => k.name === 'ttl'), 'an expired key is not listed');
  _setKvNow(() => Math.floor(Date.now() / 1000));
  assert.ok([...vfs.files.keys()].every((p) => p.startsWith('home/user/app/.nimbus/kv/CACHE/')),
    'every file is under the project root\'s .nimbus/kv/<binding>/');
}

// ── R2 ───────────────────────────────────────────────────────────────────────
{
  const vfs = memoryVfs();
  const r2 = new R2Emulator({ vfs, root: 'home/user/app', binding: 'BUCKET', onLog: () => {} });
  for (const key of KEYS) await r2.put(key, `body of ${key}`);
  await r2.put('blob', new Blob(['from a blob']));
  assert.equal(await (await r2.get('blob')).text(), 'from a blob', 'a Blob body is stored as its bytes');
  assert.equal(await new Response((await r2.get('b#1')).body).text(), 'body of b#1', 'the body streams its bytes');

  const pages = [];
  let cursor;
  do {
    const page = await r2.list({ limit: 2, cursor });
    pages.push(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  assert.deepEqual(pages, [['a/b c', 'a/b%d'], ['a/ü', 'b#1'], ['blob']], 'a listing pages in key order to its end');

  const grouped = await r2.list({ delimiter: '/' });
  assert.deepEqual(grouped.delimitedPrefixes, ['a/']);
  assert.deepEqual(grouped.objects.map((o) => o.key), ['b#1', 'blob']);

  await r2.delete(['a/b c', 'blob']);
  assert.equal(await r2.head('a/b c'), null);
  assert.deepEqual((await r2.list()).objects.map((o) => o.key), ['a/b%d', 'a/ü', 'b#1']);
  assert.ok([...vfs.files.keys()].every((p) => p.startsWith('home/user/app/.nimbus/r2/BUCKET/')));
  assert.equal(vfs.files.size, 6, 'a delete removes the body and its sidecar');
}

console.log('binding-object-store: ok');
