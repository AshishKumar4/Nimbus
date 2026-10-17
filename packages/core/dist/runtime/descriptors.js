/**
 * A process's open file descriptions and the descriptors that name them:
 * one numbering per process (DescriptorScope), shared by its synchronous
 * and asynchronous faces, whatever filesystem each description is on. A
 * description on SQLite is the engine's (SqliteVFS.openDescription); one on
 * a mount is the namespace's (vfs/mounted-description.ts), and answers by
 * awaiting when its mount does (`awaits`): the synchronous face refuses
 * that one as it refuses its mount, before anything is done.
 */
import { andThen, isPromise } from '../vfs/vfs.js';
import { fsError } from '../vfs/vfs-error.js';
/** An open's flags as its descriptor keeps them: neither access asked is O_RDONLY. */
export function openFlags(flags) {
    // O_PATH asks no access (RuntimeOpenFlags.path).
    if (flags.path === true) {
        return { read: false, write: false, append: false, create: false, exclusive: false, directory: !!flags.directory, truncate: false, followSymlinks: flags.followSymlinks !== false };
    }
    return {
        read: !!flags.read || !flags.write,
        write: !!flags.write,
        append: !!flags.append,
        create: !!flags.create,
        exclusive: !!flags.exclusive,
        directory: !!flags.directory,
        truncate: !!flags.truncate,
        followSymlinks: flags.followSymlinks !== false,
        expectedRevision: flags.expectedRevision,
    };
}
/** A description on an asynchronous mount, asked of a caller that cannot wait: its mount's refusal (isAsyncMountRefusal). */
export function awaitsRefusal(path) {
    return Object.assign(fsError('EAGAIN', 'fd', path, undefined, { detail: 'a descriptor on an asynchronous mount; this caller cannot wait for it' }), { asyncMount: true });
}
export function createDescriptorScope() {
    return { nextId: 1, handles: new Map(), held: new Set(), waveDescriptions: new Map(), closed: false, abort: null, subscriptions: new Set(), leases: new Map() };
}
/** What acts through `scope` with no binding of its own: anything, while the scope is open (EBADF once closed). */
export function scopeAccess(scope) {
    const open = () => {
        if (scope.closed)
            throw fsError('EBADF', 'fd', 'filesystem scope closed');
    };
    return { authority: open, owned: open };
}
/** The signal `scope`'s close aborts, made on first ask: already aborted once it has closed. */
export function scopeSignal(scope) {
    if (scope.abort === null) {
        scope.abort = new AbortController();
        if (scope.closed)
            scope.abort.abort();
    }
    return scope.abort.signal;
}
/** `scope` closes: what asked for its signal hears of it. */
export function closeScopeSignal(scope) {
    scope.closed = true;
    scope.abort?.abort();
}
/**
 * A description's last close: a buffered mount handle's flush. A flush that
 * fails loses the writes it held, and says so: close's error for the file,
 * the failure as its cause (EIO where it carries no code: an abort, a dropped
 * call). Node's close reports a deferred write's failure the same way.
 */
function lastClose({ node, handle }, admit) {
    const lost = (error) => {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'EIO';
        const reason = error instanceof Error ? error.message : String(error);
        // Named as it is now while the description says; a closed one (an engine description's failed close is) by its open's name.
        let name;
        try {
            name = node.path();
        }
        catch {
            name = handle.path;
        }
        throw fsError(code, 'close', name, undefined, { detail: `its buffered writes are lost (${reason})`, cause: error });
    };
    try {
        const closed = node.mounted ? node.close(admit) : node.close();
        return isPromise(closed) ? closed.catch(lost) : closed;
    }
    catch (error) {
        return lost(error);
    }
}
/** This process's descriptions of the file `key` names (MountedFileDescription.key) that hold writes, in open order. */
function holding(scope, key) {
    if (key === null)
        return [];
    return [...scope.held].filter((node) => node.key() === key).sort((a, b) => a.order - b.order);
}
/**
 * This process's held writes on the file `key` names, written, in open
 * order: before the process cuts that file (a truncate, an O_TRUNC open, a
 * whole-file write), so the cut is ordered after them, as the page cache
 * orders them (VFS-PF-001), and nothing brings back what it cut. A
 * description holds writes only where its mount answers at once, so this is
 * done in the caller's turn. One that fails keeps its failure for its next
 * fsync or close, and the cut goes on.
 */
export function settleHeld(scope, key) {
    if (scope.held.size === 0)
        return;
    for (const node of holding(scope, key))
        node.settle();
}
/** settleHeld of the file `file` finds (a path's, CompositeVFS.pin), looked up only while the process holds writes; a lookup that fails settles nothing (the cut's own lookup says why). */
export function settleHeldAt(scope, file) {
    if (scope.held.size === 0)
        return;
    const settle = (found) => andThen(found.key(), (key) => settleHeld(scope, key));
    try {
        const settled = andThen(file(), settle);
        return isPromise(settled) ? settled.catch(() => { }) : settled;
    }
    catch {
        // The cut's own lookup refuses as it refuses.
    }
}
/**
 * Closes every description `scope` holds, each whatever another's flush
 * answers, and empties it at once. The closes that failed (lastClose's
 * errors) are answered once every one has (an awaiting description's backend
 * close awaits), for the caller to report once the rest of its teardown is
 * done (reportLost): a teardown that stopped at the first one would keep the
 * scope, and everything it revokes, open.
 */
export function closeDescriptions(scope) {
    const lost = [];
    const closing = [];
    for (const opened of scope.handles.values()) {
        if (--opened.refs !== 0)
            continue;
        opened.handle.closed = true;
        try {
            const closed = lastClose(opened);
            if (isPromise(closed))
                closing.push(closed.catch((error) => { lost.push(error); }));
        }
        catch (error) {
            lost.push(error);
        }
    }
    scope.handles.clear();
    scope.held.clear();
    scope.waveDescriptions.clear();
    return closing.length === 0 ? lost : Promise.all(closing).then(() => lost);
}
/** Reports closeDescriptions' failures: the one, or EIO over them all. */
export function reportLost(lost) {
    if (lost.length === 1)
        throw lost[0];
    if (lost.length > 1) {
        throw Object.assign(new AggregateError(lost, `EIO: the buffered writes of ${lost.length} descriptors are lost`), { code: 'EIO' });
    }
}
/**
 * A mounted file as this process sees it while it holds writes to it
 * (VFS-PF-001 viewAs, page-cache semantics): `file`'s content with each of
 * this process's descriptions of that same file (HeldFile.key) applied, in
 * open order. Undefined when it holds none for it: then the file's own
 * content is the answer. Another process's held writes are never in it, nor
 * a file that only shares its name. `file` is asked only once some
 * description holds writes.
 */
export function processView(scope, file) {
    if (scope.held.size === 0)
        return undefined;
    return andThen(file(), (viewed) => andThen(viewed.key(), (key) => {
        const mine = holding(scope, key);
        if (mine.length === 0)
            return undefined;
        return andThen(viewed.readAll(), (base) => mine.reduce((view, node) => node.applyPending(view), base));
    }));
}
/** The descriptor operations, over a scope: answered in the caller's turn unless the description awaits. */
export class Descriptors {
    scope;
    clock;
    authority;
    owned;
    synchronous;
    constructor(scope, 
    /** The SQLite clock: the revision an fstat of a description on SQLite reports. */
    clock, 
    /**
     * Its binding's: asked as each call reaches its description, and passed
     * to a mount's description to ask right before the mount is.
     */
    authority, 
    /**
     * Its binding's own standing, its caller's abort aside: what a close (and
     * the table's own bookkeeping, dup) asks, so a caller that gave up still
     * closes what it opened, and an ended binding closes nothing.
     */
    owned, 
    /** A synchronous face's: a description that awaits refuses its operations (awaitsRefusal), as its mount does; every other answers at once. */
    synchronous = false) {
        this.scope = scope;
        this.clock = clock;
        this.authority = authority;
        this.owned = owned;
        this.synchronous = synchronous;
    }
    /** A descriptor for `node`, new, at offset 0, opened at `path` (the description's own name for its file unless the opener has it). */
    issue(node, flags, path = node.path()) {
        const handle = { id: this.scope.nextId++, path, flags: Object.freeze(flags), position: 0, closed: false };
        this.scope.handles.set(handle.id, { handle, node, refs: 1 });
        return { ...handle };
    }
    /**
     * issue's descriptor as an open answers it: with its file's stat, as fstat
     * answers it, its revision `revision` where the open went by a name (the
     * name's).
     */
    open(node, flags, path = node.path(), revision) {
        const handle = { id: this.scope.nextId++, path, flags: Object.freeze(flags), position: 0, closed: false };
        this.scope.handles.set(handle.id, { handle, node, refs: 1 });
        if (node.mounted)
            return andThen(node.stat(this.authority), (stat) => ({ ...handle, stat: revision === undefined ? stat : { ...stat, revision } }));
        return { ...handle, stat: { ...node.stat(), revision: revision ?? this.clock() } };
    }
    /** The description `id` names, to answer from (EBADF when none, or once the scope is closed). */
    description(id) {
        return this.answering(id).node;
    }
    opened(id, check = this.owned) {
        check();
        const opened = this.scope.handles.get(id);
        if (!opened)
            throw fsError('EBADF', 'fd', String(id));
        return opened;
    }
    /** Descriptor `id`, for an operation that answers: refused on a synchronous face where its description awaits. */
    answering(id) {
        const opened = this.opened(id, this.authority);
        if (this.synchronous && opened.node.awaits === true)
            throw awaitsRefusal(opened.node.path());
        return opened;
    }
    // A descriptor's reads and writes answer in the caller's turn without a
    // callback where the description does (andThen allocates one per call).
    // An explicit offset is where they are, never a negative one (EINVAL, as
    // pread(2) answers it); null is the descriptor's own.
    read(id, offset, length) {
        const { handle, node } = this.answering(id);
        if (!handle.flags.read)
            throw fsError('EBADF', 'read', handle.path);
        if (offset != null && offset < 0)
            throw fsError('EINVAL', 'read', handle.path);
        const start = offset ?? handle.position;
        const out = node.mounted ? node.read(start, Math.max(0, length), this.authority) : node.read(start, Math.max(0, length));
        if (offset != null)
            return out;
        if (isPromise(out))
            return out.then((bytes) => read(handle, start, bytes));
        return read(handle, start, out);
    }
    write(id, offset, bytes) {
        const { handle, node } = this.answering(id);
        if (!handle.flags.write)
            throw fsError('EBADF', 'write', handle.path);
        if (offset != null && offset < 0)
            throw fsError('EINVAL', 'write', handle.path);
        // A positional write moves no offset, O_APPEND's at the end included (pwrite(2) on Linux).
        if (handle.flags.append && node.mounted) {
            const end = node.append(bytes, this.authority);
            if (offset != null)
                return isPromise(end) ? end.then(() => bytes.byteLength) : bytes.byteLength;
            if (isPromise(end))
                return end.then((at) => moved(handle, at, bytes));
            return moved(handle, end, bytes);
        }
        // The engine's O_APPEND: at the end it keeps (VfsOpenDescription.end).
        const start = handle.flags.append && !node.mounted ? node.end?.() ?? node.stat().size : offset ?? handle.position;
        return this.writeAt(handle, node, start, offset, bytes);
    }
    writeAt(handle, node, at, offset, bytes) {
        const written = node.mounted ? node.write(at, bytes, this.authority) : node.write(at, bytes);
        if (offset != null)
            return isPromise(written) ? written.then(() => bytes.byteLength) : bytes.byteLength;
        if (isPromise(written))
            return written.then(() => moved(handle, at + bytes.byteLength, bytes));
        return moved(handle, at + bytes.byteLength, bytes);
    }
    /** The last close of a description answers what it failed with (lastClose); an earlier one closes only the descriptor. */
    close(id) {
        const opened = this.opened(id);
        this.scope.handles.delete(id);
        if (--opened.refs !== 0)
            return;
        opened.handle.closed = true;
        return lastClose(opened, this.owned);
    }
    /**
     * Writes what the description's file has held: a buffered mount handle's
     * writes, the appends SqliteVFS holds (appendThrough). Any other write was
     * in the store before its call returned.
     */
    fsync(id) {
        if (id === undefined)
            return;
        const node = this.answering(id).node;
        return node.mounted ? node.flush(this.authority) : node.flush?.();
    }
    /** The absolute path a descriptor was opened at. */
    path(id) {
        return this.opened(id).node.path();
    }
    /** The name descriptor `id` was opened by: what its errors name, its file having none now perhaps. */
    openedAs(id) {
        return this.opened(id).handle.path;
    }
    fstat(id) {
        const node = this.answering(id).node;
        return node.mounted ? node.stat(this.authority) : { ...node.stat(), revision: this.clock() };
    }
    dup(id) {
        const opened = this.opened(id);
        const dup = this.scope.nextId++;
        opened.refs++;
        this.scope.handles.set(dup, opened);
        return { ...opened.handle, id: dup };
    }
    seek(id, offset, whence) {
        const handle = this.answering(id).handle;
        const base = whence === 'set' ? 0 : whence === 'current' ? handle.position : whence === 'end' ? andThen(this.fstat(id), (stat) => stat.size) : NaN;
        return andThen(base, (from) => {
            const position = from + offset;
            if (!Number.isSafeInteger(position) || position < 0)
                throw fsError('EINVAL', 'seek', handle.path);
            handle.position = position;
            return position;
        });
    }
    setStatus(id, status) {
        const handle = this.opened(id).handle;
        if (status.append !== undefined)
            handle.flags = Object.freeze({ ...handle.flags, append: status.append });
    }
    readdir(id) {
        const node = this.answering(id).node;
        return node.mounted ? node.readdir(this.authority) : node.readdir();
    }
    /** ftruncate(2) of a descriptor not open for writing is EINVAL, as Linux answers it. */
    ftruncate(id, size) {
        const { handle, node } = this.answering(id);
        if (!handle.flags.write)
            throw fsError('EINVAL', 'ftruncate', handle.path);
        return node.mounted ? node.truncate(size, this.authority) : node.truncate(size);
    }
    fchmod(id, mode) {
        const node = this.answering(id).node;
        return node.mounted ? node.chmod(mode, this.authority) : node.chmod(mode);
    }
    fchown(id, uid, gid) {
        const node = this.answering(id).node;
        return node.mounted ? node.chown(uid, gid, this.authority) : node.chown(uid, gid);
    }
    futimes(id, atime, mtime) {
        const node = this.answering(id).node;
        return node.mounted ? node.utimes(atime, mtime, this.authority) : node.utimes(atime, mtime);
    }
}
/** A read at the descriptor's offset: the offset moved past what it read. */
function read(handle, start, bytes) {
    handle.position = start + bytes.byteLength;
    return bytes;
}
/** A write at the descriptor's offset (or its end): the offset left at `end`. */
function moved(handle, end, bytes) {
    handle.position = end;
    return bytes.byteLength;
}
