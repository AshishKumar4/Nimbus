/**
 * SqliteVFS as a `VFS`: what a CompositeVFS mounts.
 *
 * The engine keeps its own POSIX surface (CredentialedVfs, keys without a
 * leading slash, stat that throws); this is the same credentialed view
 * speaking the filesystem interface. It is synchronous (its `sync` is
 * itself), credentialed (`as(cred)` is another principal's view of the same
 * database), and revisioned: every stat carries the row's revision, so a
 * cache over it can see a change. Errors become VfsError with the engine's
 * code.
 */
import { ROOT_DIRECTORY_MODE, ROOT_INODE } from './sqlite-vfs.js';
import { syscallError, toVfsError, VfsError } from './vfs-error.js';
function absolute(key) {
    return key.startsWith('/') ? key : `/${key}`;
}
/**
 * A revision is the row's generation qualified by the database's epoch: a
 * restore or reset can reuse generations, and a revision from before it
 * must not match one after.
 */
function revisionOf(epoch, gen) {
    return `${epoch}:${gen}`;
}
function statOf(stat, epoch) {
    return {
        dev: stat.dev,
        type: stat.type,
        size: stat.size,
        mtimeMs: stat.mtime,
        atimeMs: stat.atime,
        ctimeMs: stat.ctime,
        mode: stat.mode,
        uid: stat.uid,
        gid: stat.gid,
        ino: stat.ino,
        nlink: stat.nlink,
        ...(stat.gen !== undefined ? { revision: revisionOf(epoch, stat.gen) } : {}),
    };
}
export class SqliteFiles {
    engine;
    view;
    sync = this;
    /** The database's change feed, in this principal's view (names it could list). */
    changes;
    constructor(engine, view) {
        this.engine = engine;
        this.view = view;
        // The engine names paths by key (no leading slash); this interface's
        // paths are absolute, the feed's included.
        this.changes = {
            get epoch() { return view.epoch; },
            revision: () => view.revision(),
            since: (epoch, cursor, options) => {
                const delta = view.acquire(epoch, cursor, options);
                for (const entry of delta.paths)
                    entry.path = absolute(entry.path);
                return delta;
            },
            list: (after, limit) => {
                const page = view.list(after === null ? null : after.replace(/^\/+/, ''), limit);
                for (const entry of page.entries)
                    entry.path = absolute(entry.path);
                return { ...page, next: page.next === null ? null : absolute(page.next) };
            },
        };
    }
    /** The engine's credentialed view this speaks for (for the engine's own callers). */
    get credentialed() {
        return this.view;
    }
    as(cred) {
        return new SqliteFiles(this.engine, this.engine.as(cred));
    }
    /** `op`, its engine errors as Node's for `syscall` on `path` (and `dest`). */
    run(syscall, path, op, dest) {
        try {
            return op();
        }
        catch (error) {
            throw toVfsError(error, syscall, path, dest);
        }
    }
    stat(path, options) {
        // The root has no row: it is 0755 root:root by definition.
        if (path.replace(/\/+/g, '') === '') {
            return { dev: this.engine.deviceId, ino: ROOT_INODE, type: 'directory', size: 0, mtimeMs: 0, mode: ROOT_DIRECTORY_MODE, uid: 0, gid: 0, revision: `${this.view.epoch}:0` };
        }
        try {
            return statOf(options?.follow === false ? this.view.lstat(path) : this.view.stat(path), this.view.epoch);
        }
        catch (error) {
            const converted = toVfsError(error, options?.follow === false ? 'lstat' : 'stat', path);
            if (converted instanceof VfsError && converted.code === 'ENOENT')
                return null;
            throw converted;
        }
    }
    readFile(path) {
        return this.run('open', path, () => this.view.readFile(path));
    }
    readRange(path, offset, length) {
        return this.run('open', path, () => this.view.readRange(path, offset, length));
    }
    writeFile(path, data, options) {
        this.run('open', path, () => this.view.writeFile(path, data, options));
    }
    writeRange(path, offset, bytes) {
        this.run('open', path, () => this.view.writeRange(path, offset, bytes));
    }
    truncate(path, size) {
        this.run('open', path, () => this.view.truncate(path, size));
    }
    readdir(path) {
        return this.run('scandir', path, () => this.view.readdir(path).map((entry) => ({ name: entry.name, type: entry.type })));
    }
    mkdir(path, options) {
        this.run('mkdir', path, () => {
            // mkdir(2): an existing name is EEXIST (the engine's own mkdir is idempotent).
            if (!options?.recursive && this.view.exists(path))
                throw syscallError('EEXIST', 'mkdir', path);
            this.view.mkdir(path, options);
        });
    }
    unlink(path) {
        this.run('unlink', path, () => this.view.unlink(path));
    }
    rmdir(path) {
        this.run('rmdir', path, () => this.view.rmdir(path));
    }
    rename(from, to) {
        this.run('rename', from, () => this.view.rename(from, to), to);
    }
    removeRecursive(path) {
        this.run('rm', path, () => { this.view.removeRecursive(path); });
    }
    symlink(target, path) {
        this.run('symlink', target, () => this.view.symlink(target, path), path);
    }
    readlink(path) {
        return this.run('readlink', path, () => this.view.readlink(path));
    }
    chmod(path, mode) {
        this.run('chmod', path, () => this.view.chmod(path, mode));
    }
    chown(path, uid, gid) {
        this.run('chown', path, () => this.view.chown(path, uid, gid));
    }
    utimes(path, atimeMs, mtimeMs) {
        this.run('utime', path, () => this.view.utimes(path, atimeMs, mtimeMs));
    }
    /** Copy inside the database: rows, not bytes. */
    copy(from, to, options) {
        return this.run(options?.recursive ? 'cp' : 'copyfile', from, () => {
            if (!options?.recursive) {
                this.view.copyFile(from, to);
                return 1;
            }
            return this.view.copyTree(from, to, { preserve: options.preserve });
        }, to);
    }
    /**
     * Compare-and-write against the row's revision, in one synchronous step:
     * nothing can commit between the check and the write, because both run in
     * this isolate's turn on the same database.
     */
    writeFileIfRevision(path, data, expected) {
        return this.run('open', path, () => {
            // Absent is revision 0; revisions compare as strings, so '0' and 0 agree.
            const current = this.stat(path)?.revision ?? 0;
            if (String(current) !== String(expected))
                return { ok: false, revision: current };
            this.view.writeFile(path, data);
            return { ok: true, revision: this.stat(path)?.revision ?? 0 };
        });
    }
    describe() {
        return { source: 'sqlite', type: 'nimbusfs', options: ['rw'] };
    }
}
/** The database as `cred` sees it, as a VFS. */
export function sqliteFiles(engine, cred) {
    return new SqliteFiles(engine, engine.as(cred));
}
