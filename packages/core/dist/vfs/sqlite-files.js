import { VfsError, VFS_ERRNO } from './vfs-error.js';
function absolute(key) {
    return key.startsWith('/') ? key : `/${key}`;
}
function toVfsError(error, path) {
    if (error instanceof VfsError)
        return error;
    const code = error?.code;
    if (typeof code === 'string' && code in VFS_ERRNO) {
        const message = error instanceof Error ? error.message.replace(new RegExp(`^${code}: `), '') : String(error);
        return new VfsError(code, message, path, { cause: error });
    }
    return error;
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
    run(path, op) {
        try {
            return op();
        }
        catch (error) {
            throw toVfsError(error, path);
        }
    }
    stat(path, options) {
        try {
            return statOf(options?.follow === false ? this.view.lstat(path) : this.view.stat(path), this.view.epoch);
        }
        catch (error) {
            const converted = toVfsError(error, path);
            if (converted instanceof VfsError && converted.code === 'ENOENT')
                return null;
            throw converted;
        }
    }
    readFile(path) {
        return this.run(path, () => this.view.readFile(path));
    }
    readRange(path, offset, length) {
        return this.run(path, () => this.view.readRange(path, offset, length));
    }
    writeFile(path, data, options) {
        this.run(path, () => this.view.writeFile(path, data, options));
    }
    writeRange(path, offset, bytes) {
        this.run(path, () => this.view.writeRange(path, offset, bytes));
    }
    truncate(path, size) {
        this.run(path, () => this.view.truncate(path, size));
    }
    readdir(path) {
        return this.run(path, () => this.view.readdir(path).map((entry) => ({ name: entry.name, type: entry.type })));
    }
    mkdir(path, options) {
        this.run(path, () => {
            // mkdir(2): an existing name is EEXIST (the engine's own mkdir is idempotent).
            if (!options?.recursive && this.view.exists(path))
                throw new VfsError('EEXIST', 'file exists', path);
            this.view.mkdir(path, options);
        });
    }
    unlink(path) {
        this.run(path, () => this.view.unlink(path));
    }
    rmdir(path) {
        this.run(path, () => this.view.rmdir(path));
    }
    rename(from, to) {
        this.run(from, () => this.view.rename(from, to));
    }
    removeRecursive(path) {
        this.run(path, () => { this.view.removeRecursive(path); });
    }
    symlink(target, path) {
        this.run(path, () => this.view.symlink(target, path));
    }
    readlink(path) {
        return this.run(path, () => this.view.readlink(path));
    }
    chmod(path, mode) {
        this.run(path, () => this.view.chmod(path, mode));
    }
    chown(path, uid, gid) {
        this.run(path, () => this.view.chown(path, uid, gid));
    }
    utimes(path, atimeMs, mtimeMs) {
        this.run(path, () => this.view.utimes(path, atimeMs, mtimeMs));
    }
    /** Copy inside the database: rows, not bytes. */
    copy(from, to, options) {
        return this.run(from, () => {
            if (!options?.recursive) {
                this.view.copyFile(from, to);
                return 1;
            }
            return this.view.copyTree(from, to, { preserve: options.preserve });
        });
    }
    /**
     * Compare-and-write against the row's revision, in one synchronous step:
     * nothing can commit between the check and the write, because both run in
     * this isolate's turn on the same database.
     */
    writeFileIfRevision(path, data, expected) {
        return this.run(path, () => {
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
