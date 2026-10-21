import { pageOf, treeListing } from './immutable-changes.js';
import { runtimeStatOf } from './runtime-stat.js';
import { syscallError } from './vfs-error.js';
import { timeAt } from './posix-access.js';
import { utf8Length } from '@nimbus-sh/platform/utf8.js';
import { rootClampedSegments } from '@nimbus-sh/platform/lexical-path.js';
const EMPTY = new Uint8Array(0);
function fail(code, call) {
    return syscallError(code, call.syscall, call.path, { dest: call.dest });
}
export class MemoryVFS {
    owner;
    /** VFS.storesWrites: a regular file holds what it was written. */
    storesWrites = true;
    root;
    clock = 0;
    inos = 0;
    /** Entries in its tree, its root among them: what bounds its tombstones. */
    count = 0;
    /** Each changed path's newest change (absolute), in the order of their revisions; `gone`: a removal. */
    changed = new Map();
    tombstones = 0;
    /** The newest pruned removal's revision: a cursor below it is a poison. */
    floor = 0;
    listed = null;
    epoch = `memory:${crypto.randomUUID()}`;
    sync = this;
    changes;
    constructor(owner = { uid: 0, gid: 0 }) {
        this.owner = owner;
        this.root = this.entry('directory', 0o755);
        const vfs = this;
        this.changes = {
            epoch: this.epoch,
            revision: () => vfs.clock,
            since: (epoch, cursor, options) => vfs.since(epoch, cursor, options?.namespace === true),
            list: (after, limit) => {
                if (vfs.listed === null || vfs.listed.rev !== vfs.clock)
                    vfs.listed = { rev: vfs.clock, entries: treeListing(vfs) };
                return pageOf(vfs.listed.entries, after, limit, vfs.epoch, vfs.clock);
            },
        };
    }
    entry(type, mode) {
        const fields = {
            ino: ++this.inos, data: new Uint8Array(0), target: '', mode, mtimeMs: Date.now(), revision: ++this.clock,
        };
        this.count++;
        return type === 'directory' ? { type, ...fields, children: new Map() } : { type, ...fields, children: null };
    }
    /** What changed since `cursor` of `epoch`: each path's newest change after it, with its lstat now where `stats`. */
    since(epoch, cursor, stats) {
        const rev = this.clock;
        if (epoch !== this.epoch || cursor < this.floor || cursor > rev)
            return { epoch: this.epoch, rev, paths: [], poison: true };
        const paths = [];
        for (const [path, change] of this.changed) {
            if (change.rev <= cursor)
                continue;
            const entry = change.structural ? { path, rev: change.rev, structural: true } : { path, rev: change.rev };
            if (stats) {
                let stat = null;
                try {
                    stat = this.stat(path, { follow: false });
                }
                catch {
                    stat = null;
                }
                entry.stat = stat === null ? null : runtimeStatOf(stat);
                if (stat?.type === 'symlink')
                    entry.linkTarget = this.readlink(path);
            }
            paths.push(entry);
        }
        return { epoch: this.epoch, rev, paths, poison: false };
    }
    /**
     * The name in the tree `path` leads to, as find walks it: each link on the
     * way followed, a final one where `follow`; where a name on the way is
     * missing, the rest as spelled.
     */
    treePath(path, follow, hops = 0) {
        const parts = rootClampedSegments(path);
        let at = this.root;
        for (let i = 0; i < parts.length; i++) {
            const next = at.type === 'directory' ? at.children.get(parts[i]) : undefined;
            if (next === undefined)
                return `/${parts.join('/')}`;
            if (next.type === 'symlink' && (follow || i < parts.length - 1) && hops < 40) {
                const base = next.target.startsWith('/') ? '' : `/${parts.slice(0, i).join('/')}`;
                return this.treePath(`${base}/${next.target}/${parts.slice(i + 1).join('/')}`, follow, hops + 1);
            }
            at = next;
        }
        return `/${parts.join('/')}`;
    }
    /** The tree name of `path`'s directory, as parentOf finds it (its links followed). */
    treeParent(path) {
        const parts = rootClampedSegments(path);
        parts.pop();
        return this.treePath(`/${parts.join('/')}`, true);
    }
    /**
     * The tree name `key` changed now (treePath, treeParent: a change through a
     * link is its target's). `structural`: a directory removed, moved or given
     * another mode; `gone`: nothing is there.
     */
    note(key, structural = false, gone = false) {
        const had = this.changed.get(key);
        if (had !== undefined) {
            this.changed.delete(key);
            if (had.gone)
                this.tombstones--;
        }
        this.changed.set(key, { rev: this.clock, structural, gone });
        if (!gone)
            return;
        this.tombstones++;
        // What was under a removed directory is covered by its removal, which is newer.
        if (structural) {
            const under = key === '/' ? '/' : `${key}/`;
            for (const [at, change] of this.changed) {
                if (at.startsWith(under)) {
                    this.changed.delete(at);
                    if (change.gone)
                        this.tombstones--;
                }
            }
        }
        for (const [at, change] of this.changed) {
            if (this.tombstones <= this.count)
                break;
            if (!change.gone)
                continue;
            this.changed.delete(at);
            this.tombstones--;
            if (change.rev > this.floor)
                this.floor = change.rev;
        }
    }
    /** The entries `entry` holds, itself among them. */
    static sizeOf(entry) {
        let n = 1;
        if (entry.type === 'directory')
            for (const child of entry.children.values())
                n += MemoryVFS.sizeOf(child);
        return n;
    }
    touch(entry) {
        entry.mtimeMs = Date.now();
        entry.revision = ++this.clock;
    }
    /** The entry at `path`, following symlinks except a final one when `follow` is false; `call` names a failure. */
    find(path, call, follow = true, hops = 0) {
        const parts = rootClampedSegments(path);
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
        const parts = rootClampedSegments(path);
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
    /** VFS.fileStore: its tree, whichever object (a wrapper of it) is asked. */
    get fileStore() {
        return this.root;
    }
    stats(entry) {
        return {
            ino: entry.ino,
            type: entry.type,
            size: entry.type === 'symlink' ? utf8Length(entry.target) : entry.data.length,
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
            this.note(this.treePath(path, true));
            return;
        }
        const { dir, name } = this.parentOf(path, call);
        const entry = this.entry('file', options?.mode ?? 0o644);
        entry.data = bytes;
        dir.children.set(name, entry);
        this.touch(dir);
        this.note(this.treePath(path, false));
        this.note(this.treeParent(path));
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
        this.note(this.treePath(path, true));
    }
    truncate(path, size) {
        const entry = this.file(path, { syscall: 'open', path });
        const next = new Uint8Array(size);
        next.set(entry.data.subarray(0, Math.min(size, entry.data.length)));
        entry.data = next;
        this.touch(entry);
        this.note(this.treePath(path, true));
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
    /** With `recursive`, the directories it made, top down (VFS.mkdir). */
    mkdir(path, options) {
        const call = { syscall: 'mkdir', path };
        if (options?.recursive) {
            const made = [];
            let at = '';
            for (const part of rootClampedSegments(path)) {
                at += `/${part}`;
                const existing = this.find(at, call);
                if (existing === null) {
                    this.mkdir(at, { mode: options.mode });
                    made.push(at);
                }
                else if (existing.type !== 'directory')
                    throw fail('ENOTDIR', call);
            }
            return made;
        }
        if (this.find(path, call, false) !== null)
            throw fail('EEXIST', call);
        const { dir, name } = this.parentOf(path, call);
        dir.children.set(name, this.entry('directory', options?.mode ?? 0o755));
        this.touch(dir);
        this.note(this.treePath(path, false));
        this.note(this.treeParent(path));
    }
    unlink(path) {
        const call = { syscall: 'unlink', path };
        if (rootClampedSegments(path).length === 0)
            throw fail('EISDIR', call);
        const { dir, name } = this.parentOf(path, call);
        const entry = dir.children.get(name);
        if (entry === undefined)
            throw fail('ENOENT', call);
        if (entry.type === 'directory')
            throw fail('EISDIR', call);
        dir.children.delete(name);
        this.count--;
        this.touch(dir);
        this.note(this.treePath(path, false), false, true);
        this.note(this.treeParent(path));
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
        this.count--;
        this.touch(dir);
        this.note(this.treePath(path, false), true, true);
        this.note(this.treeParent(path));
    }
    removeRecursive(path) {
        const call = { syscall: 'rm', path };
        const { dir, name } = this.parentOf(path, call);
        const entry = dir.children.get(name);
        if (entry === undefined)
            throw fail('ENOENT', call);
        dir.children.delete(name);
        this.count -= MemoryVFS.sizeOf(entry);
        this.touch(dir);
        this.note(this.treePath(path, false), entry.type === 'directory', true);
        this.note(this.treeParent(path));
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
        const fromKey = rootClampedSegments(from).join('/');
        const toKey = rootClampedSegments(to).join('/');
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
        if (replaced !== undefined)
            this.count--;
        this.touch(source.dir);
        this.touch(target.dir);
        // A directory moved is structural at both names: what was under it is under the new one, which a reader lists again.
        this.note(this.treePath(from, false), entry.type === 'directory', true);
        this.note(this.treePath(to, false), entry.type === 'directory' || replaced?.type === 'directory');
        this.note(this.treeParent(from));
        this.note(this.treeParent(to));
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
        this.note(this.treePath(path, false));
        this.note(this.treeParent(path));
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
        this.note(this.treePath(path, true), entry.type === 'directory');
    }
    /** Its entries keep an mtime alone: the atime is taken and dropped. */
    utimes(path, _atime, mtime) {
        const call = { syscall: 'utime', path };
        const entry = this.find(path, call);
        if (entry === null)
            throw fail('ENOENT', call);
        entry.mtimeMs = timeAt(mtime, entry.mtimeMs, Date.now());
        entry.revision = ++this.clock;
        this.note(this.treePath(path, true));
    }
    describe() {
        return { source: 'memory', type: 'tmpfs', options: ['rw'] };
    }
}
