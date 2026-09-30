import { syscallError } from './vfs-error.js';
const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);
function fail(code, call) {
    return syscallError(code, call.syscall, call.path, { dest: call.dest });
}
function segments(path) {
    const out = [];
    for (const segment of path.split('/')) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..')
            out.pop();
        else
            out.push(segment);
    }
    return out;
}
export class MemoryVFS {
    owner;
    root;
    clock = 0;
    sync = this;
    constructor(owner = { uid: 0, gid: 0 }) {
        this.owner = owner;
        this.root = this.entry('directory', 0o755);
    }
    entry(type, mode) {
        const fields = {
            data: new Uint8Array(0), target: '', mode, mtimeMs: Date.now(), revision: ++this.clock,
        };
        return type === 'directory' ? { type, ...fields, children: new Map() } : { type, ...fields, children: null };
    }
    touch(entry) {
        entry.mtimeMs = Date.now();
        entry.revision = ++this.clock;
    }
    /** The entry at `path`, following symlinks except a final one when `follow` is false; `call` names a failure. */
    find(path, call, follow = true, hops = 0) {
        const parts = segments(path);
        let at = this.root;
        for (let i = 0; i < parts.length; i++) {
            if (at.type !== 'directory')
                throw fail('ENOTDIR', call);
            const next = at.children.get(parts[i]);
            if (next === undefined)
                return null;
            if (next.type === 'symlink' && (follow || i < parts.length - 1)) {
                if (hops >= 40)
                    throw fail('ELOOP', call);
                const base = next.target.startsWith('/') ? '' : `/${parts.slice(0, i).join('/')}`;
                return this.find(`${base}/${next.target}/${parts.slice(i + 1).join('/')}`, call, follow, hops + 1);
            }
            at = next;
        }
        return at;
    }
    parentOf(path, call) {
        const parts = segments(path);
        const name = parts.pop();
        if (name === undefined)
            throw syscallError('EBUSY', call.syscall, call.path, { dest: call.dest, detail: 'the root cannot be replaced' });
        const dir = this.find(`/${parts.join('/')}`, call);
        if (dir === null)
            throw fail('ENOENT', call);
        if (dir.type !== 'directory')
            throw fail('ENOTDIR', call);
        return { dir, name };
    }
    stats(entry) {
        return {
            type: entry.type,
            size: entry.type === 'symlink' ? encoder.encode(entry.target).length : entry.data.length,
            mtimeMs: entry.mtimeMs,
            revision: entry.revision,
            mode: entry.mode,
            uid: this.owner.uid,
            gid: this.owner.gid,
        };
    }
    file(path, call) {
        const entry = this.find(path, call);
        if (entry === null)
            throw fail('ENOENT', call);
        if (entry.type === 'directory')
            throw fail('EISDIR', call);
        return entry;
    }
    stat(path, options) {
        const entry = this.find(path, { syscall: options?.follow === false ? 'lstat' : 'stat', path }, options?.follow !== false);
        return entry === null ? null : this.stats(entry);
    }
    readFile(path) {
        return this.file(path, { syscall: 'open', path }).data.slice();
    }
    readRange(path, offset, length) {
        return this.file(path, { syscall: 'open', path }).data.slice(offset, offset + length);
    }
    writeFile(path, data, options) {
        const call = { syscall: 'open', path };
        const bytes = data.slice();
        const existing = this.find(path, call);
        if (existing !== null) {
            if (existing.type === 'directory')
                throw fail('EISDIR', call);
            existing.data = bytes;
            this.touch(existing);
            return;
        }
        const { dir, name } = this.parentOf(path, call);
        const entry = this.entry('file', options?.mode ?? 0o644);
        entry.data = bytes;
        dir.children.set(name, entry);
        this.touch(dir);
    }
    writeRange(path, offset, bytes) {
        const call = { syscall: 'open', path };
        if (this.find(path, call) === null)
            this.writeFile(path, EMPTY);
        const entry = this.file(path, call);
        const next = new Uint8Array(Math.max(entry.data.length, offset + bytes.length));
        next.set(entry.data);
        next.set(bytes, offset);
        entry.data = next;
        this.touch(entry);
    }
    truncate(path, size) {
        const entry = this.file(path, { syscall: 'open', path });
        const next = new Uint8Array(size);
        next.set(entry.data.subarray(0, Math.min(size, entry.data.length)));
        entry.data = next;
        this.touch(entry);
    }
    readdir(path) {
        const call = { syscall: 'scandir', path };
        const entry = this.find(path, call);
        if (entry === null)
            throw fail('ENOENT', call);
        if (entry.type !== 'directory')
            throw fail('ENOTDIR', call);
        return [...entry.children].map(([name, child]) => ({ name, type: child.type, stat: this.stats(child) }));
    }
    mkdir(path, options) {
        const call = { syscall: 'mkdir', path };
        if (options?.recursive) {
            let at = '';
            for (const part of segments(path)) {
                at += `/${part}`;
                const existing = this.find(at, call);
                if (existing === null)
                    this.mkdir(at, { mode: options.mode });
                else if (existing.type !== 'directory')
                    throw fail('ENOTDIR', call);
            }
            return;
        }
        if (this.find(path, call, false) !== null)
            throw fail('EEXIST', call);
        const { dir, name } = this.parentOf(path, call);
        dir.children.set(name, this.entry('directory', options?.mode ?? 0o755));
        this.touch(dir);
    }
    unlink(path) {
        const call = { syscall: 'unlink', path };
        if (segments(path).length === 0)
            throw fail('EISDIR', call);
        const { dir, name } = this.parentOf(path, call);
        const entry = dir.children.get(name);
        if (entry === undefined)
            throw fail('ENOENT', call);
        if (entry.type === 'directory')
            throw fail('EISDIR', call);
        dir.children.delete(name);
        this.touch(dir);
    }
    rmdir(path) {
        const call = { syscall: 'rmdir', path };
        const { dir, name } = this.parentOf(path, call);
        const entry = dir.children.get(name);
        if (entry === undefined)
            throw fail('ENOENT', call);
        if (entry.type !== 'directory')
            throw fail('ENOTDIR', call);
        if (entry.children.size > 0)
            throw fail('ENOTEMPTY', call);
        dir.children.delete(name);
        this.touch(dir);
    }
    removeRecursive(path) {
        const call = { syscall: 'rm', path };
        const { dir, name } = this.parentOf(path, call);
        if (!dir.children.delete(name))
            throw fail('ENOENT', call);
        this.touch(dir);
    }
    /**
     * POSIX rename(2): a file target is replaced; a directory replaces an empty
     * directory; onto itself, nothing changes.
     */
    rename(from, to) {
        // Both parents are resolved before the source is looked up, as rename(2)
        // does: a bad component on either side is its error before ENOENT.
        const call = { syscall: 'rename', path: from, dest: to };
        const source = this.parentOf(from, call);
        const target = this.parentOf(to, call);
        const entry = source.dir.children.get(source.name);
        if (entry === undefined)
            throw fail('ENOENT', call);
        const fromKey = segments(from).join('/');
        const toKey = segments(to).join('/');
        if (fromKey === toKey)
            return;
        if (entry.type === 'directory' && `${toKey}/`.startsWith(`${fromKey}/`)) {
            throw syscallError('EINVAL', 'rename', from, { dest: to, detail: 'a directory cannot move beneath itself' });
        }
        const replaced = target.dir.children.get(target.name);
        if (replaced !== undefined) {
            if (entry.type === 'directory' && replaced.type !== 'directory')
                throw fail('ENOTDIR', call);
            if (entry.type !== 'directory' && replaced.type === 'directory')
                throw fail('EISDIR', call);
            if (replaced.type === 'directory' && replaced.children.size > 0)
                throw fail('ENOTEMPTY', call);
        }
        source.dir.children.delete(source.name);
        target.dir.children.set(target.name, entry);
        this.touch(source.dir);
        this.touch(target.dir);
    }
    symlink(target, path) {
        const call = { syscall: 'symlink', path: target, dest: path };
        if (this.find(path, call, false) !== null)
            throw fail('EEXIST', call);
        const { dir, name } = this.parentOf(path, call);
        const entry = this.entry('symlink', 0o777);
        entry.target = target;
        dir.children.set(name, entry);
        this.touch(dir);
    }
    readlink(path) {
        const call = { syscall: 'readlink', path };
        const entry = this.find(path, call, false);
        if (entry === null)
            throw fail('ENOENT', call);
        if (entry.type !== 'symlink')
            throw fail('EINVAL', call);
        return entry.target;
    }
    chmod(path, mode) {
        const call = { syscall: 'chmod', path };
        const entry = this.find(path, call);
        if (entry === null)
            throw fail('ENOENT', call);
        entry.mode = mode & 0o7777;
        this.touch(entry);
    }
    utimes(path, _atimeMs, mtimeMs) {
        const call = { syscall: 'utime', path };
        const entry = this.find(path, call);
        if (entry === null)
            throw fail('ENOENT', call);
        entry.mtimeMs = mtimeMs;
        entry.revision = ++this.clock;
    }
    describe() {
        return { source: 'memory', type: 'tmpfs', options: ['rw'] };
    }
}
