// An asynchronous backend in memory, the shape of the remote mounts an
// embedder puts on `ws.filesystem.vfs` (a drive, a device, a container):
// every call awaits a turn of the event loop, as a remote call would, and
// there is no `sync` face. Kinu's repro Worker mounts exactly this at /m.

import { VfsError } from '../../../packages/core/src/vfs/vfs-error.ts';

export function asyncMemoryVfs() {
  const nodes = new Map([['/', { type: 'directory', mode: 0o40777, mtimeMs: Date.now() }]]);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fail = (code, path) => { throw new VfsError(code, `${code}: ${path}`, path); };
  const parentOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
  const nameOf = (path) => path.slice(path.lastIndexOf('/') + 1);
  const normalize = (path) => {
    const out = [];
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') out.pop();
      else out.push(part);
    }
    return `/${out.join('/')}`;
  };
  const resolve = (path, follow, depth = 0) => {
    const node = nodes.get(path);
    if (!follow || node?.type !== 'symlink' || depth > 16) return path;
    const target = node.target.startsWith('/') ? node.target : `${parentOf(path)}/${node.target}`;
    return resolve(normalize(target), true, depth + 1);
  };
  const dir = (path) => {
    const node = nodes.get(resolve(path, true));
    if (node === undefined) fail('ENOENT', path);
    if (node.type !== 'directory') fail('ENOTDIR', path);
  };
  const file = (path) => {
    const node = nodes.get(resolve(path, true));
    if (node === undefined) fail('ENOENT', path);
    if (node.type !== 'file') fail('EISDIR', path);
    return node;
  };
  const statOf = (node) => ({
    type: node.type,
    size: node.type === 'file' ? node.data.byteLength : node.type === 'symlink' ? node.target.length : 4096,
    mtimeMs: node.mtimeMs,
    mode: node.mode,
    uid: 1000,
    gid: 1000,
  });
  const put = (path, data, mode = 0o100644) => {
    const at = resolve(path, true);
    dir(parentOf(at));
    const held = nodes.get(at);
    if (held?.type === 'directory') fail('EISDIR', path);
    nodes.set(at, { type: 'file', data, mode: held?.mode ?? mode, mtimeMs: Date.now() });
  };
  const children = (path) => {
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...nodes.keys()].filter((key) => key !== path && key.startsWith(prefix) && !key.slice(prefix.length).includes('/'));
  };

  return {
    async stat(path, options) { await tick(); const node = nodes.get(resolve(path, options?.follow !== false)); return node === undefined ? null : statOf(node); },
    async readFile(path) { await tick(); return file(path).data.slice(); },
    async writeFile(path, data, options) { await tick(); put(path, data.slice(), options?.mode === undefined ? undefined : 0o100000 | options.mode); },
    async readdir(path) {
      await tick();
      const at = resolve(path, true);
      dir(at);
      return children(at).map((key) => ({ name: nameOf(key), type: nodes.get(key).type, stat: statOf(nodes.get(key)) }));
    },
    async mkdir(path, options) {
      await tick();
      if (options?.recursive) {
        let at = '';
        for (const part of path.split('/').filter(Boolean)) {
          at = resolve(`${at}/${part}`, true);
          const node = nodes.get(at);
          if (node === undefined) nodes.set(at, { type: 'directory', mode: 0o40755, mtimeMs: Date.now() });
          else if (node.type !== 'directory') fail('ENOTDIR', at);
        }
        return;
      }
      if (nodes.has(path)) fail('EEXIST', path);
      dir(parentOf(path));
      nodes.set(path, { type: 'directory', mode: 0o40000 | (options?.mode ?? 0o755), mtimeMs: Date.now() });
    },
    async unlink(path) { await tick(); const node = nodes.get(path); if (node === undefined) fail('ENOENT', path); if (node.type === 'directory') fail('EISDIR', path); nodes.delete(path); },
    async rmdir(path) { await tick(); dir(path); if (children(path).length > 0) fail('ENOTEMPTY', path); nodes.delete(path); },
    async rename(from, to) {
      await tick();
      if (!nodes.has(from)) fail('ENOENT', from);
      dir(parentOf(to));
      for (const key of [...nodes.keys()].sort()) {
        if (key === from || key.startsWith(`${from}/`)) {
          const node = nodes.get(key);
          nodes.delete(key);
          nodes.set(to + key.slice(from.length), node);
        }
      }
    },
    async readRange(path, offset, length) { await tick(); return file(path).data.slice(offset, offset + length); },
    async writeRange(path, offset, bytes) {
      await tick();
      const held = nodes.get(resolve(path, true));
      const base = held?.type === 'file' ? held.data : new Uint8Array(0);
      const next = new Uint8Array(Math.max(base.byteLength, offset + bytes.byteLength));
      next.set(base);
      next.set(bytes, offset);
      put(path, next);
    },
    async truncate(path, size) { await tick(); const held = file(path); const next = new Uint8Array(size); next.set(held.data.subarray(0, size)); put(path, next); },
    async symlink(target, path) { await tick(); if (nodes.has(path)) fail('EEXIST', path); dir(parentOf(path)); nodes.set(path, { type: 'symlink', target, mode: 0o120777, mtimeMs: Date.now() }); },
    async readlink(path) { await tick(); const node = nodes.get(path); if (node?.type !== 'symlink') fail('EINVAL', path); return node.target; },
    async chmod(path, mode) { await tick(); const node = nodes.get(resolve(path, true)); if (node === undefined) fail('ENOENT', path); node.mode = (node.mode & 0o170000) | (mode & 0o7777); },
    async utimes(path, _atimeMs, mtimeMs) { await tick(); const node = nodes.get(resolve(path, true)); if (node === undefined) fail('ENOENT', path); node.mtimeMs = mtimeMs; },
    describe: () => ({ source: 'memory', type: 'repro-async' }),
  };
}

/**
 * `vfs` as a mount with no synchronous face: `sync` is absent, so the
 * namespace awaits every call. By default the backend's own methods answer
 * as they do (a synchronous backend still returns at once). `deep` makes the
 * face asynchronous all the way down, as an embedder's drive or device is:
 * every method answers a promise on a later turn, and a view as a principal
 * (`as()`) is as asynchronous.
 */
export function asyncOnly(vfs, { deep = false } = {}) {
  return new Proxy(vfs, {
    get(target, key) {
      if (key === 'sync') return undefined;
      const value = target[key];
      if (typeof value !== 'function') return value;
      if (!deep) return value.bind(target);
      if (key === 'as') return (...args) => asyncOnly(value.apply(target, args), { deep });
      return (...args) => Promise.resolve().then(() => value.apply(target, args));
    },
    has: (target, key) => key !== 'sync' && key in target,
  });
}
