#!/usr/bin/env bun
// tsrs-file-operations — tsrs's file import (@tsrs/wasm's `tsrs_host.fs`)
// answered from a process's filesystem as @tsrs/wasm's own Node host answers
// it: a missing path is "not found" (null), a stat is "<kind> <size>
// <mtime ns>", a listing names each entry's kind (a link as l, an entry the
// backend cannot type is typed by a stat), a write makes its directories,
// an append adds, a removal is recursive and ignores a missing path, and a
// failure is thrown for the caller to report.

import assert from 'node:assert/strict';
import { tsrsFileOperation } from '../../packages/core/src/runtime/facet-tasks.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
const op = { read: 0, stat: 1, readDir: 2, realpath: 3, write: 4, append: 5, remove: 6, chtimes: 7 };
const fail = (code) => Object.assign(new Error(`${code}: refused`), { code });

/** A filesystem of `files` (path → text) and `dirs`, with a link /l → /src, as the bridge answers. */
function bridge() {
  const files = new Map([['/src/a.ts', 'export {};\n'], ['/locked', 'x']]);
  const dirs = new Set(['/', '/src']);
  const times = new Map();
  let handles = 0;
  const open = new Map();
  const parentOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
  return {
    files, dirs, times,
    stat: async (path, options) => {
      if (path === '/l') return options?.followSymlinks === false ? { type: 'symlink', size: 4, mtime: 1 } : { type: 'directory', size: 0, mtime: 1 };
      if (dirs.has(path)) return { type: 'directory', size: 0, mtime: 1500.25 };
      if (files.has(path)) return { type: 'file', size: enc.encode(files.get(path)).length, mtime: 1500.25 };
      return null;
    },
    readFile: async (path) => {
      if (path === '/locked') throw fail('EACCES');
      if (dirs.has(path)) throw fail('EISDIR');
      return files.has(path) ? enc.encode(files.get(path)) : null;
    },
    readdir: async (path) => {
      if (!dirs.has(path)) throw fail('ENOENT');
      const names = [...files.keys(), ...dirs].filter((p) => p !== path && parentOf(p) === path).map((p) => ({ name: p.slice(path.length === 1 ? 1 : path.length + 1), type: dirs.has(p) ? 'directory' : 'file' }));
      return path === '/' ? [...names, { name: 'l', type: 'unknown' }] : names;
    },
    realpath: async (path) => {
      if (path === '/l') return '/src';
      if (dirs.has(path) || files.has(path)) return path;
      throw fail('ENOENT');
    },
    writeFile: async (path, bytes, options) => {
      if (!dirs.has(parentOf(path))) {
        if (!options?.createParents) throw fail('ENOENT');
        for (let at = parentOf(path); !dirs.has(at); at = parentOf(at)) dirs.add(at);
      }
      files.set(path, dec.decode(bytes));
      return 1;
    },
    mkdir: async (path) => { for (let at = path; !dirs.has(at); at = parentOf(at)) dirs.add(at); },
    open: async (path) => {
      if (!dirs.has(parentOf(path))) throw fail('ENOENT');
      if (!files.has(path)) files.set(path, '');
      open.set(++handles, path);
      return { id: handles };
    },
    write: async (id, _offset, bytes) => { const path = open.get(id); files.set(path, files.get(path) + dec.decode(bytes)); return bytes.length; },
    close: async (id) => { open.delete(id); },
    remove: async (path) => {
      for (const p of [...files.keys()]) if (p === path || p.startsWith(`${path}/`)) files.delete(p);
      for (const p of [...dirs]) if (p === path || p.startsWith(`${path}/`)) dirs.delete(p);
    },
    utimes: async (path, atime, mtime) => { times.set(path, [atime, mtime]); },
  };
}
const text = (answer) => (typeof answer === 'string' ? answer : dec.decode(answer));
const request = (path, rest) => (rest === undefined ? enc.encode(path) : new Uint8Array([...enc.encode(path), 0, ...(typeof rest === 'string' ? enc.encode(rest) : rest)]));

{
  const fs = bridge();
  assert.equal(text(await tsrsFileOperation(fs, op.read, request('/src/a.ts'))), 'export {};\n');
  assert.equal(await tsrsFileOperation(fs, op.read, request('/src/none.ts')), null, 'a missing file is not found');
  assert.equal(await tsrsFileOperation(fs, op.stat, request('/src/none.ts')), null, 'and so is its stat');
  assert.equal(await tsrsFileOperation(fs, op.stat, request('/src/a.ts')), 'f 11 1500250000', 'a stat: kind, size, mtime in ns');
  assert.equal(await tsrsFileOperation(fs, op.stat, request('/l')), 'd 0 1000000', 'a stat follows a link');
  assert.equal(await tsrsFileOperation(fs, op.readDir, request('/src')), 'fa.ts\0');
  assert.equal(await tsrsFileOperation(fs, op.readDir, request('/')), 'flocked\0dsrc\0ll\0', 'an untyped entry is typed by its lstat: a link');
  assert.equal(await tsrsFileOperation(fs, op.readDir, request('/none')), null, 'a missing directory is not found');
  assert.equal(await tsrsFileOperation(fs, op.realpath, request('/l')), '/src');
  assert.equal(await tsrsFileOperation(fs, op.realpath, request('/none')), null);
  await assert.rejects(tsrsFileOperation(fs, op.read, request('/locked')), { code: 'EACCES' }, 'a refusal is thrown, for the caller to report');
  console.log('  ✓ reads, stats, listings, realpath');
}
{
  const fs = bridge();
  assert.equal(await tsrsFileOperation(fs, op.write, request('/out/deep/a.js', 'export {};\n')), '');
  assert.equal(fs.files.get('/out/deep/a.js'), 'export {};\n', 'a write makes the directories it lands in');
  assert.ok(fs.dirs.has('/out/deep'));
  assert.equal(await tsrsFileOperation(fs, op.write, request('/out/bin', new Uint8Array([0, 1, 2]))), '');
  assert.deepEqual([...enc.encode(fs.files.get('/out/bin'))], [0, 1, 2], 'its bytes are everything after the path\'s NUL, NULs included');
  await tsrsFileOperation(fs, op.append, request('/out/deep/a.js', 'tail\n'));
  assert.equal(fs.files.get('/out/deep/a.js'), 'export {};\ntail\n', 'an append adds');
  await tsrsFileOperation(fs, op.append, request('/logs/trace.txt', 'one\n'));
  assert.equal(fs.files.get('/logs/trace.txt'), 'one\n', 'and makes its directories too');
  await tsrsFileOperation(fs, op.chtimes, request('/out/deep/a.js', '1000000000\u00002500000000'));
  assert.deepEqual(fs.times.get('/out/deep/a.js'), [1000, 2500], 'times arrive in ns and go to the filesystem in ms');
  assert.equal(await tsrsFileOperation(fs, op.remove, request('/out')), '');
  assert.ok(!fs.files.has('/out/deep/a.js') && !fs.dirs.has('/out'), 'a removal is recursive');
  assert.equal(await tsrsFileOperation(fs, op.remove, request('/out')), '', 'and a missing path is no error');
  await assert.rejects(tsrsFileOperation(fs, 99, request('/x')), /unknown file operation 99/);
  console.log('  ✓ writes, appends, times, removals');
}
console.log('tsrs-file-operations: ok');
