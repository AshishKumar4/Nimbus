#!/usr/bin/env bun
// A mount that resolves its own paths (MountOptions.resolvesPaths) is handed
// the rest of a path as written, its `.`, `..` and trailing slash included,
// for its backend to walk as a kernel does (Kinu ask 58): `/m/missing/../f`
// is ENOENT and `/m/f/` ENOTDIR, as they are at `/`, and a `..` after a link
// climbs from where the link leads. A `..` past the mount's root still leaves
// it, and an ordinary path still reaches the backend in one call.
//
// Red before: the namespace collapsed `.`, `..` and the trailing slash first,
// so the backend was asked for `/f` and read the file.
import assert from 'node:assert/strict';
import { CompositeVFS } from '../../packages/core/src/vfs/composite.ts';
import { MemoryVFS } from '../../packages/core/src/vfs/memory.ts';
import { syscallError } from '../../packages/core/src/vfs/vfs-error.ts';

const text = new TextEncoder();

/**
 * A backend that walks a path as a kernel does, component by component (a
 * `..` pops what the walk reached, a link is followed where it is met, a
 * trailing slash wants a directory), over a MemoryVFS, recording every path
 * it is asked about.
 */
function walking() {
  const tree = new MemoryVFS();
  const asked = [];
  const walk = async (path, syscall) => {
    const components = path.split('/');
    const trailing = path.length > 1 && path.endsWith('/');
    let at = [];
    for (let i = 0; i < components.length; i++) {
      const name = components[i];
      if (name === '' || name === '.') continue;
      if (name === '..') { at.pop(); continue; }
      const here = `/${[...at, name].join('/')}`;
      const last = components.slice(i + 1).every((rest) => rest === '' || rest === '.');
      const stat = await tree.stat(here, { follow: false });
      if (stat === null) throw syscallError('ENOENT', syscall, path);
      if (stat.type === 'symlink' && (!last || trailing)) {
        const target = await tree.readlink(here);
        at = target.startsWith('/') ? target.split('/').filter(Boolean) : [...at, ...target.split('/').filter(Boolean)];
        continue;
      }
      if (!last && stat.type !== 'directory') throw syscallError('ENOTDIR', syscall, path);
      at.push(name);
    }
    const reached = `/${at.join('/')}`;
    if (trailing && (await tree.stat(reached))?.type !== 'directory') throw syscallError('ENOTDIR', syscall, path);
    return reached;
  };
  const backend = {
    async readFile(path) { asked.push(`readFile ${path}`); return tree.readFile(await walk(path, 'open')); },
    async stat(path, options) {
      asked.push(`stat ${path}`);
      try { return await tree.stat(await walk(path, 'stat'), options); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async readdir(path) { asked.push(`readdir ${path}`); return tree.readdir(await walk(path, 'scandir')); },
    async writeFile(path, data) { asked.push(`writeFile ${path}`); return tree.writeFile(await walk(path, 'open'), data); },
    async mkdir(path, options) { return tree.mkdir(path, options); },
    async unlink(path) { asked.push(`unlink ${path}`); return tree.unlink(await walk(path, 'unlink')); },
    async rmdir(path) { return tree.rmdir(path); },
    async rename(from, to) { return tree.rename(from, to); },
    async readlink(path) { return tree.readlink(path); },
    async symlink(target, path) { return tree.symlink(target, path); },
  };
  return { tree, backend, asked };
}

const outcome = async (run) => {
  try { await run(); return 'ok'; } catch (error) { return error.code ?? String(error); }
};

const { tree, backend, asked } = walking();
await tree.mkdir('/dir', { recursive: true });
await tree.mkdir('/a', { recursive: true });
await tree.writeFile('/f', text.encode('the file'));
await tree.writeFile('/a/b', text.encode('b'));
await tree.writeFile('/dir/g', text.encode('g'));
await tree.symlink('/dir', '/link');
const root = new MemoryVFS();
await root.mkdir('/m', { recursive: true });
await root.writeFile('/x', text.encode('the namespace'));
const namespace = new CompositeVFS(root);
namespace.mount('/m', backend, { resolvesPaths: true });

const cases = [
  ['readFile', '/m/missing/../f', 'ENOENT', 'readFile /missing/../f'],
  ['readFile', '/m/f/', 'ENOTDIR', 'readFile /f/'],
  ['readFile', '/m/link/../f', 'ok', 'readFile /link/../f'],
  ['readFile', '/m/dir/./g', 'ok', 'readFile /dir/./g'],
  ['readdir', '/m/f/', 'ENOTDIR', 'readdir /f/'],
  ['readFile', '/m/a/b', 'ok', 'readFile /a/b'],
];
for (const [op, path, want, call] of cases) {
  asked.length = 0;
  const got = await outcome(() => namespace[op](path));
  assert.equal(got, want, `${op} ${path}`);
  assert.deepEqual(asked, [call], `${op} ${path}: the backend is asked once, for the path as written`);
}

// stat of a path whose walk fails is null, as the backend walked it.
asked.length = 0;
assert.equal(await namespace.stat('/m/missing/../f'), null);
assert.deepEqual(asked, ['stat /missing/../f']);

// A `..` past the mount's root leaves it: the namespace's /x. The backend is asked only
// for its root, whose search permission the walk through /m needs (as Linux's).
asked.length = 0;
assert.equal(new TextDecoder().decode(await namespace.readFile('/m/../x')), 'the namespace');
assert.deepEqual(asked, ['stat /']);

// The same spellings at the namespace's own root answer the same.
const plain = new CompositeVFS(tree);
assert.equal(await outcome(() => plain.readFile('/missing/../f')), 'ENOENT');
assert.equal(await outcome(() => plain.readFile('/f/')), 'ENOTDIR');

console.log('composite-resolves-paths-verbatim: ok');
