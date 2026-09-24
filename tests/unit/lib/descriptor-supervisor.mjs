import { posix } from 'node:path';

/** Add the descriptor RPC contract to an external-storage test double. */
export function descriptorSupervisor(supervisor) {
  const handles = new Map();
  const identities = new Map();
  const directories = new Set(['']);
  let nextHandle = 1;
  const error = code => Object.assign(new Error(code), { code });
  const get = id => { const handle = handles.get(id); if (!handle) throw error('EBADF'); return handle; };
  const path = value => {
    if (typeof value === 'string') return posix.normalize('/' + value).slice(1);
    return path(posix.join('root' in value ? value.root : get(value.directory).path, value.path));
  };
  const originalStat = supervisor.stat;
  const decorate = (name, info) => {
    if (!info) return null;
    if (!identities.has(name)) identities.set(name, identities.size + 1);
    return { dev: 1, ino: identities.get(name), nlink: 1, atime: 0, mtime: 0, ctime: 0, uid: 1000, gid: 1000, mode: 0o777, revision: 0, ...info };
  };
  const stat = async value => {
    const name = path(value);
    let info = originalStat ? await originalStat.call(supervisor, name) : null;
    if (!info && supervisor.store?.has(name)) info = { type: 'file', size: supervisor.store.get(name).length };
    if (!info && (directories.has(name) || [...(supervisor.store?.keys() ?? [])].some(key => key.startsWith(name + '/')))) info = { type: 'directory', size: 0 };
    return decorate(name, info);
  };
  const originalMkdir = supervisor.mkdir;
  if (originalMkdir) supervisor.mkdir = async value => { const name = path(value); const result = await originalMkdir.call(supervisor, name); directories.add(name); return result; };
  for (const key of ['unlink', 'rmdir', 'readlink', 'readdir']) {
    const fn = supervisor[key];
    if (fn) supervisor[key] = (value, ...args) => fn.call(supervisor, path(value), ...args);
  }
  const rename = supervisor.rename;
  if (rename) supervisor.rename = async (from, to) => { const source = path(from), target = path(to); const result = await rename.call(supervisor, source, target); for (const handle of handles.values()) if (handle.path === source) handle.path = target; return result; };
  const symlink = supervisor.symlink;
  if (symlink) supervisor.symlink = (target, value) => symlink.call(supervisor, target, path(value));
  return Object.assign(supervisor, {
    stat,
    async fsOpen(value, flags) {
      const name = path(value);
      let info = await supervisor.stat(name);
      if (info && flags.create && flags.exclusive) throw error('EEXIST');
      if (!info && flags.create) { await supervisor.writeFile(name, new Uint8Array()); info = await stat(name); }
      if (!info) throw error('ENOENT');
      if (flags.directory && info.type !== 'directory') throw error('ENOTDIR');
      if (flags.truncate) await supervisor.fsTruncate(name, 0);
      const handle = { id: nextHandle++, path: name, flags, position: 0, closed: false };
      handles.set(handle.id, handle);
      return { ...handle };
    },
    async fsFstat(id) { const name = get(id).path; return decorate(name, await supervisor.stat(name)); },
    async fsRead(id, offset, length) {
      const handle = get(id), position = offset ?? handle.position;
      const bytes = await supervisor.fsReadRange(handle.path, position, length);
      if (bytes === null) throw error('ENOENT');
      if (offset === null) handle.position += bytes.length;
      return bytes;
    },
    async fsWrite(id, offset, bytes) {
      const handle = get(id);
      const position = handle.flags.append ? (await stat(handle.path)).size : offset ?? handle.position;
      const count = await supervisor.fsWriteRange(handle.path, position, bytes);
      if (offset === null || handle.flags.append) handle.position = position + count;
      return count;
    },
    async fsClose(id) { get(id); handles.delete(id); },
    async fsSeek(id, offset, whence) { const handle = get(id); handle.position = (whence === 'set' ? 0 : whence === 'current' ? handle.position : (await stat(handle.path)).size) + offset; return handle.position; },
    async fsSetStatus(id, flags) { const handle = get(id); handle.flags = { ...handle.flags, ...flags }; },
    async fsFtruncate(id, size) { return supervisor.fsTruncate(get(id).path, size); },
    async fsReaddirHandle(id) { return supervisor.readdir(get(id).path); },
    async fsSync(id) { if (id !== undefined) get(id); },
    async access(value) { if (!await stat(value)) throw error('ENOENT'); },
    async fsRealpath(value) { const name = path(value); if (!await stat(name)) throw error('ENOENT'); return '/' + name; },
  });
}
