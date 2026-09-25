import { VfsError } from './vfs-error.js';
const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);
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
        return {
            type, data: new Uint8Array(0), target: '', mode, mtimeMs: Date.now(), revision: ++this.clock,
            children: type === 'directory' ? new Map() : null,
        };
    }
    touch(entry) {
        entry.mtimeMs = Date.now();
        entry.revision = ++this.clock;
    }
    /** The entry at `path`, following symlinks except a final one when `follow` is false. */
    find(path, follow = true, hops = 0) {
        const parts = segments(path);
        let at = this.root;
        for (let i = 0; i < parts.length; i++) {
            if (at.type !== 'directory')
                throw new VfsError('ENOTDIR', 'not a directory', path);
            const next = at.children.get(parts[i]);
            if (next === undefined)
                return null;
            if (next.type === 'symlink' && (follow || i < parts.length - 1)) {
                if (hops >= 40)
                    throw new VfsError('ELOOP', 'too many symbolic links', path);
                const base = next.target.startsWith('/') ? '' : `/${parts.slice(0, i).join('/')}`;
                return this.find(`${base}/${next.target}/${parts.slice(i + 1).join('/')}`, follow, hops + 1);
            }
            at = next;
        }
        return at;
    }
    parentOf(path) {
        const parts = segments(path);
        const name = parts.pop();
        if (name === undefined)
            throw new VfsError('EBUSY', 'the root cannot be replaced', path);
        const dir = this.find(`/${parts.join('/')}`);
        if (dir === null)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        if (dir.type !== 'directory')
            throw new VfsError('ENOTDIR', 'not a directory', path);
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
    file(path) {
        const entry = this.find(path);
        if (entry === null)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        if (entry.type === 'directory')
            throw new VfsError('EISDIR', 'is a directory', path);
        return entry;
    }
    stat(path, options) {
        const entry = this.find(path, options?.follow !== false);
        return entry === null ? null : this.stats(entry);
    }
    readFile(path) {
        return this.file(path).data.slice();
    }
    readRange(path, offset, length) {
        return this.file(path).data.slice(offset, offset + length);
    }
    writeFile(path, data, options) {
        const bytes = data.slice();
        const existing = this.find(path);
        if (existing !== null) {
            if (existing.type === 'directory')
                throw new VfsError('EISDIR', 'is a directory', path);
            existing.data = bytes;
            this.touch(existing);
            return;
        }
        const { dir, name } = this.parentOf(path);
        const entry = this.entry('file', options?.mode ?? 0o644);
        entry.data = bytes;
        dir.children.set(name, entry);
        this.touch(dir);
    }
    writeRange(path, offset, bytes) {
        if (this.find(path) === null)
            this.writeFile(path, EMPTY);
        const entry = this.file(path);
        const next = new Uint8Array(Math.max(entry.data.length, offset + bytes.length));
        next.set(entry.data);
        next.set(bytes, offset);
        entry.data = next;
        this.touch(entry);
    }
    truncate(path, size) {
        const entry = this.file(path);
        const next = new Uint8Array(size);
        next.set(entry.data.subarray(0, Math.min(size, entry.data.length)));
        entry.data = next;
        this.touch(entry);
    }
    readdir(path) {
        const entry = this.find(path);
        if (entry === null)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        if (entry.type !== 'directory')
            throw new VfsError('ENOTDIR', 'not a directory', path);
        return [...entry.children].map(([name, child]) => ({ name, type: child.type, stat: this.stats(child) }));
    }
    mkdir(path, options) {
        if (options?.recursive) {
            let at = '';
            for (const part of segments(path)) {
                at += `/${part}`;
                const existing = this.find(at);
                if (existing === null)
                    this.mkdir(at, { mode: options.mode });
                else if (existing.type !== 'directory')
                    throw new VfsError('ENOTDIR', 'not a directory', at);
            }
            return;
        }
        if (this.find(path, false) !== null)
            throw new VfsError('EEXIST', 'file exists', path);
        const { dir, name } = this.parentOf(path);
        dir.children.set(name, this.entry('directory', options?.mode ?? 0o755));
        this.touch(dir);
    }
    unlink(path) {
        if (segments(path).length === 0)
            throw new VfsError('EISDIR', 'is a directory', path);
        const { dir, name } = this.parentOf(path);
        const entry = dir.children.get(name);
        if (entry === undefined)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        if (entry.type === 'directory')
            throw new VfsError('EISDIR', 'is a directory', path);
        dir.children.delete(name);
        this.touch(dir);
    }
    rmdir(path) {
        const { dir, name } = this.parentOf(path);
        const entry = dir.children.get(name);
        if (entry === undefined)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        if (entry.type !== 'directory')
            throw new VfsError('ENOTDIR', 'not a directory', path);
        if (entry.children.size > 0)
            throw new VfsError('ENOTEMPTY', 'directory not empty', path);
        dir.children.delete(name);
        this.touch(dir);
    }
    removeRecursive(path) {
        const { dir, name } = this.parentOf(path);
        if (!dir.children.delete(name))
            throw new VfsError('ENOENT', 'no such file or directory', path);
        this.touch(dir);
    }
    /**
     * POSIX rename(2): a file target is replaced; a directory replaces an empty
     * directory; onto itself, nothing changes.
     */
    rename(from, to) {
        // Both parents are resolved before the source is looked up, as rename(2)
        // does: a bad component on either side is its error before ENOENT.
        const source = this.parentOf(from);
        const target = this.parentOf(to);
        const entry = source.dir.children.get(source.name);
        if (entry === undefined)
            throw new VfsError('ENOENT', 'no such file or directory', from);
        const fromKey = segments(from).join('/');
        const toKey = segments(to).join('/');
        if (fromKey === toKey)
            return;
        if (entry.type === 'directory' && `${toKey}/`.startsWith(`${fromKey}/`)) {
            throw new VfsError('EINVAL', 'a directory cannot move beneath itself', to);
        }
        const replaced = target.dir.children.get(target.name);
        if (replaced !== undefined) {
            if (entry.type === 'directory' && replaced.type !== 'directory')
                throw new VfsError('ENOTDIR', 'not a directory', to);
            if (entry.type !== 'directory' && replaced.type === 'directory')
                throw new VfsError('EISDIR', 'is a directory', to);
            if (replaced.type === 'directory' && replaced.children.size > 0)
                throw new VfsError('ENOTEMPTY', 'directory not empty', to);
        }
        source.dir.children.delete(source.name);
        target.dir.children.set(target.name, entry);
        this.touch(source.dir);
        this.touch(target.dir);
    }
    symlink(target, path) {
        if (this.find(path, false) !== null)
            throw new VfsError('EEXIST', 'file exists', path);
        const { dir, name } = this.parentOf(path);
        const entry = this.entry('symlink', 0o777);
        entry.target = target;
        dir.children.set(name, entry);
        this.touch(dir);
    }
    readlink(path) {
        const entry = this.find(path, false);
        if (entry === null)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        if (entry.type !== 'symlink')
            throw new VfsError('EINVAL', 'not a symbolic link', path);
        return entry.target;
    }
    chmod(path, mode) {
        const entry = this.find(path);
        if (entry === null)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        entry.mode = mode & 0o7777;
        this.touch(entry);
    }
    utimes(path, _atimeMs, mtimeMs) {
        const entry = this.find(path);
        if (entry === null)
            throw new VfsError('ENOENT', 'no such file or directory', path);
        entry.mtimeMs = mtimeMs;
        entry.revision = ++this.clock;
    }
    describe() {
        return { source: 'memory', type: 'tmpfs', options: ['rw'] };
    }
}
