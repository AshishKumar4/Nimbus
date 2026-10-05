/**
 * A WASI process's filesystem, answered from the process's own copy of the
 * namespace where that copy can answer, and by the authority everywhere else.
 *
 * Every filesystem syscall a guest makes is a call to the session: measured
 * on a throwaway (2026-10-05), 5.9-12.7 ms for one `os.stat` from Python, so
 * a program that stats a tree pays for each name with a round trip. The
 * process already carries a store for names and bytes
 * (worker vfs/facet-resident-store.ts, the one a node process reads its
 * synchronous calls from). This adapter puts the codec's calls in front of
 * it: a lookup, a stat, a directory listing, a read-only open and its reads
 * are answered from the store; anything that changes the filesystem, and
 * anything the store cannot vouch for, goes to the authority exactly as
 * before.
 *
 * What makes an answer from the store the authority's answer:
 *   - The walk is the authority's own (beneath-walk.ts walkBeneath), its
 *     lookups answered from the store's entries, so `..`, links, search
 *     permission and every refusal come out as the authority's would.
 *   - Only the session's SQLite filesystem is answered here, recognised by
 *     its device: an entry on another device (a mount: /proc, /dev, an
 *     embedder's) changes without the change log, so it is the authority's.
 *   - The store is coherent with the authority at its cursor, and the cursor
 *     moves by the ACQUIRE barrier. The barrier is owed after any call this
 *     adapter sent to the authority that may have changed something, and
 *     after input entered the process from outside (`inbound`): before its
 *     next answer the adapter takes it, so what the guest learned elsewhere,
 *     or did itself, is in what it reads next. That is the causal rule a node
 *     process keeps (core README, process model).
 *   - A name the store does not know (its directory not listed yet) is not
 *     absent: the adapter lists the directory and walks again.
 */
import { fsError, modeAllows, walkBeneath } from '../beneath-walk.js';
import { FACET_OWN_WRITE_MEMORY_BYTES } from '@nimbus-sh/platform/limits.js';
/** Larger files are read through the authority's descriptors, never held whole here. */
export const RESIDENT_OPEN_MAX_BYTES = 8 * 1024 * 1024;
/** A held write goes to the session in pieces of this size: each fits one call. */
const WRITE_PIECE_BYTES = 1024 * 1024;
/** Listings one call may take before it gives the question to the authority. */
const MAX_LISTINGS_PER_CALL = 64;
/** Local descriptors are numbered from here, above anything the authority issues. */
const LOCAL_HANDLE_BASE = 2 ** 40;
/** What this adapter answers itself is decided here: anything else is the authority's. */
const DELEGATE = Symbol('delegate');
/** The root of the namespace as the walk asks about it (the authority's rootStat, for what the walk reads). */
const ROOT_FOR_WALK = { type: 'directory', mode: 0o40755, uid: 0, gid: 0 };
/** The calls that can change the namespace or bytes: after one, the barrier is owed. */
const MUTATIONS = new Set([
    'writeFile', 'writeFileFrom', 'writeRange', 'truncate', 'utimes', 'chmod', 'chown', 'write', 'close', 'mkdir',
    'unlink', 'rmdir', 'rename', 'symlink', 'remove', 'copyFile', 'copyTree', 'ftruncate', 'fchmod', 'fchown',
    'futimes', 'appendOnce', 'acknowledgeAppend', 'writeBatch', 'writeStream',
]);
function after(value, next) {
    return value instanceof Promise ? value.then(next) : next(value);
}
function keyOf(path) {
    return path.split('/').filter((segment) => segment !== '' && segment !== '.').join('/');
}
/** Every name on the way to `name` beneath `root`, as spelled: the root's own ancestors first, up to the first `..`. */
function prefixes(root, name) {
    const parts = [];
    const keys = [];
    for (const segment of [...root.split('/'), ...name.split('/')]) {
        if (segment === '' || segment === '.')
            continue;
        if (segment === '..')
            break;
        parts.push(segment);
        keys.push(parts.join('/'));
    }
    return keys;
}
function parentKey(key) {
    const at = key.lastIndexOf('/');
    return at < 0 ? '' : key.slice(0, at);
}
function statOf(entry) {
    return {
        dev: entry.dev, ino: entry.ino, nlink: entry.nlink, type: entry.type, size: entry.size,
        ctime: entry.ctime, atime: entry.atime, mtime: entry.mtime, mode: entry.mode, uid: entry.uid, gid: entry.gid,
        revision: entry.revision,
    };
}
export function residentFilesystem(session, resident) {
    const counts = { local: 0, delegated: {}, lookups: 0, listings: 0, treeListings: 0, fills: 0, filledBytes: 0, barriers: 0, waitMs: 0 };
    // Every wait on the session is timed where it leaves: the authority's calls
    // and the store's listings, fills and barriers. A facet's clock moves only
    // across I/O, so this is the part of a run's wall time the filesystem cost.
    const timed = (value) => {
        if (!(value instanceof Promise))
            return value;
        const started = Date.now();
        return value.finally(() => { counts.waitMs += Date.now() - started; });
    };
    const authority = new Proxy(session, {
        get(target, name, receiver) {
            const value = Reflect.get(target, name, receiver);
            if (typeof value !== 'function')
                return value;
            return (...args) => timed(Reflect.apply(value, target, args));
        },
    });
    const store = {
        get device() { return resident.device; },
        get cred() { return resident.cred; },
        ready: () => resident.ready(),
        entry: (key) => resident.entry(key),
        children: (key) => resident.children(key),
        list: (key) => timed(resident.list(key)),
        lookup: (keys, content) => timed(resident.lookup(keys, content)),
        listTree: (key) => timed(resident.listTree(key)),
        content: (key) => resident.content(key),
        fill: (key, entry) => timed(resident.fill(key, entry)),
        barrier: () => timed(resident.barrier()),
    };
    const delegated = (name) => { counts.delegated[name] = (counts.delegated[name] ?? 0) + 1; };
    let owed = false;
    let nextHandle = LOCAL_HANDLE_BASE;
    const handles = new Map();
    /** Writes held for the session's descriptors, by descriptor; and their total, against FACET_OWN_WRITE_MEMORY_BYTES. */
    const writes = new Map();
    let heldBytes = 0;
    /** Held writes the session refused, by descriptor, until reported. */
    const unsettled = new Map();
    /** The latest held write of `key`, if this process is writing it. */
    const heldAt = (key) => {
        let found;
        for (const held of writes.values())
            if (held.key === key)
                found = held;
        return found;
    };
    /** Room for `held` to reach `length` bytes. */
    const grow = (held, length) => {
        if (length <= held.bytes.byteLength)
            return;
        const next = new Uint8Array(Math.max(length, held.bytes.byteLength * 2, 4096));
        next.set(held.bytes.subarray(0, held.length));
        heldBytes += next.byteLength - held.bytes.byteLength;
        held.bytes = next;
    };
    /**
     * Send what `held` holds through its descriptor, a piece at a time, and stop
     * holding it: the descriptor is the session's again, at the position the
     * program left it at.
     */
    const release = async (held) => {
        writes.delete(held.id);
        heldBytes -= held.bytes.byteLength;
        try {
            for (let at = 0; at < held.length; at += WRITE_PIECE_BYTES) {
                await authority.write(held.id, at, held.bytes.slice(at, Math.min(held.length, at + WRITE_PIECE_BYTES)));
            }
            if (held.position !== 0)
                await authority.seek(held.id, held.position, 'set');
        }
        catch (error) {
            // Reported once: by this descriptor's close or fsync, or by the run's end.
            unsettled.set(held.id, { path: held.path, error });
            throw error;
        }
        finally {
            owed = true;
        }
    };
    /** A failure an earlier release left on `handleId`, now reported (and forgotten). */
    const takeUnsettled = (handleId) => {
        const failure = unsettled.get(handleId);
        if (failure === undefined)
            return undefined;
        unsettled.delete(handleId);
        return failure.error;
    };
    /**
     * One walk over what the store knows: the resolved key, ELOOP (null), a
     * directory to list first, or DELEGATE when the walk reaches what this
     * adapter does not answer. The authority's refusals are thrown as its own.
     */
    const walkOnce = (root, name, follow) => {
        const walk = walkBeneath(root, { root, path: name, beneath: true }, follow, store.cred, () => false);
        for (let step = walk.next();;) {
            if (step.done)
                return step.value;
            const lookup = step.value;
            if ('readlink' in lookup) {
                const entry = store.entry(keyOf(lookup.readlink));
                if (!entry || entry.type !== 'symlink' || entry.target === null)
                    return DELEGATE;
                step = walk.next(entry.target);
                continue;
            }
            const key = keyOf(lookup.stat);
            if (key === '') {
                step = walk.next(ROOT_FOR_WALK);
                continue;
            }
            const entry = store.entry(key);
            if (entry === undefined)
                return { missing: key };
            if (entry !== null && entry.dev !== store.device)
                return DELEGATE;
            step = walk.next(entry === null ? null : { type: entry.type, mode: entry.mode, uid: entry.uid, gid: entry.gid });
        }
    };
    /** Where a path leads (its key), listing what the walk needs; DELEGATE for what this adapter does not answer. */
    const resolve = (path, follow, content = false) => {
        let root;
        let name;
        if (typeof path === 'string') {
            if (path.split('/').includes('..'))
                return DELEGATE;
            root = '';
            name = keyOf(path);
        }
        else if ('root' in path) {
            root = keyOf(path.root);
            name = path.path;
        }
        else {
            const handle = handles.get(path.directory);
            if (handle === undefined || handle.entry.type !== 'directory')
                return DELEGATE;
            root = handle.key;
            name = path.path;
        }
        // A name the store does not know is looked up first, with every name on
        // the way to it as spelled (one round trip however deep); a name that is
        // still not known is not there or past a link, and its directory is
        // listed (which also says what is absent in it).
        const looked = new Set();
        const attempt = (asked) => {
            const walked = walkOnce(root, name, follow);
            if (walked === null || walked === DELEGATE || typeof walked === 'string')
                return walked;
            if (asked >= MAX_LISTINGS_PER_CALL)
                return DELEGATE;
            if (!looked.has(walked.missing)) {
                const spelled = prefixes(root, name).filter((key) => !looked.has(key) && store.entry(key) === undefined);
                const keys = spelled.includes(walked.missing) ? spelled.slice(spelled.indexOf(walked.missing)) : [walked.missing];
                for (const key of keys)
                    looked.add(key);
                counts.lookups++;
                // The bytes of what the call names, when it is a small file: a stat is followed by an open.
                const target = spelled[spelled.length - 1];
                return store.lookup(keys, content && keys[keys.length - 1] === target)
                    .then((known) => (known ? attempt(asked + 1) : DELEGATE));
            }
            counts.listings++;
            return store.list(parentKey(walked.missing)).then((listed) => (listed ? attempt(asked + 1) : DELEGATE));
        };
        return attempt(0);
    };
    /** The entry a resolved key names, or undefined when the store cannot say (the authority answers). */
    const entryAt = (key) => {
        const entry = store.entry(key);
        if (entry === undefined)
            return undefined;
        if (entry !== null && entry.dev !== store.device)
            return undefined;
        // What this process has written and not yet sent is what it reads back.
        const held = heldAt(key);
        if (held !== undefined && entry !== null && entry.type === 'file')
            return { ...entry, size: held.length };
        return entry;
    };
    /** A file's bytes: the store's, or fetched into it; undefined when only the authority can read them. */
    const contentOf = (key, entry) => {
        const writing = heldAt(key);
        if (writing !== undefined)
            return writing.bytes.slice(0, writing.length);
        const held = store.content(key);
        if (held !== undefined && held.byteLength === entry.size)
            return held;
        counts.fills++;
        counts.filledBytes += entry.size;
        return store.fill(key, entry).then((bytes) => (bytes !== null && bytes.byteLength === entry.size ? bytes : undefined));
    };
    /**
     * Answer from the store when it can, else from the authority: the barrier
     * first when one is owed, then `local`, whose DELEGATE hands the call on.
     */
    const answer = (name, local, remote) => {
        const settle = (value) => {
            if (value !== DELEGATE) {
                counts.local++;
                return value;
            }
            delegated(name);
            return remote();
        };
        if (!store.ready()) {
            delegated(name);
            return remote();
        }
        if (owed) {
            owed = false;
            counts.barriers++;
            return store.barrier().then((ok) => (ok && store.ready() ? after(local(), settle) : (delegated(name), remote())));
        }
        return after(local(), settle);
    };
    /** The authority, for a call that may change what the store holds: the barrier is owed once it returns. */
    const changing = (name, call) => {
        delegated(name);
        try {
            return after(call(), (value) => { owed = true; return value; });
        }
        catch (error) {
            owed = true;
            throw error;
        }
    };
    const local = (handleId) => handles.get(handleId);
    const localBytes = (handle) => {
        if (handle.bytes !== null)
            return handle.bytes;
        return after(contentOf(handle.key, handle.entry), (bytes) => {
            if (bytes === undefined)
                throw fsError('EIO', 'read', handle.path);
            handle.bytes = bytes;
            return bytes;
        });
    };
    const fs = Object.create(null);
    // Every call this adapter does not answer goes to the authority as it came,
    // whether the bridge carries its calls itself or on its class.
    const names = new Set();
    for (let at = session; at !== null && at !== Object.prototype; at = Reflect.getPrototypeOf(at)) {
        for (const name of Reflect.ownKeys(at))
            if (typeof name === 'string' && name !== 'constructor')
                names.add(name);
    }
    for (const name of names) {
        const value = Reflect.get(authority, name);
        if (typeof value !== 'function')
            continue;
        const call = (...args) => Reflect.apply(value, authority, args);
        const mutates = MUTATIONS.has(name);
        Reflect.set(fs, name, mutates
            ? (...args) => changing(name, () => call(...args))
            : (...args) => { delegated(name); return call(...args); });
    }
    Reflect.set(fs, 'synchronous', authority.synchronous);
    fs.inbound = () => { owed = true; };
    fs.holding = () => writes.size > 0;
    fs.settle = async () => {
        for (const held of [...writes.values()]) {
            try {
                await release(held);
            }
            catch { /* recorded in unsettled */ }
        }
        const failures = [...unsettled.values()];
        unsettled.clear();
        return failures;
    };
    fs.stats = () => ({ ...counts, delegated: { ...counts.delegated } });
    fs.stat = (path, options = {}) => answer('stat', () => {
        const follow = options.followSymlinks !== false;
        const finish = (key) => {
            if (key === DELEGATE || key === '')
                return DELEGATE;
            if (key === null)
                throw fsError('ELOOP', follow ? 'stat' : 'lstat', path);
            const entry = entryAt(key);
            if (entry === undefined)
                return DELEGATE;
            return entry === null ? null : statOf(entry);
        };
        // A component missing on the way is "not there", as the authority's stat says.
        const absent = (error) => {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
                return null;
            throw error;
        };
        try {
            const resolved = resolve(path, follow, true);
            return resolved instanceof Promise ? resolved.then(finish, absent) : finish(resolved);
        }
        catch (error) {
            return absent(error);
        }
    }, () => authority.stat(path, options));
    fs.readFile = (path, options = {}) => answer('readFile', () => after(resolve(path, options.followSymlinks !== false, true), (key) => {
        if (key === DELEGATE || key === '')
            return DELEGATE;
        if (key === null)
            return null;
        const entry = entryAt(key);
        if (entry === undefined)
            return DELEGATE;
        if (entry === null)
            return null;
        // As the authority checks: permission before what kind of name it is.
        if (!modeAllows(entry, 4, store.cred))
            throw fsError('EACCES', 'open', path);
        if (entry.type === 'directory')
            throw fsError('EISDIR', 'open', path);
        if (entry.type !== 'file' || entry.size > RESIDENT_OPEN_MAX_BYTES)
            return DELEGATE;
        return after(contentOf(key, entry), (bytes) => (bytes === undefined ? DELEGATE : bytes));
    }), () => authority.readFile(path, options));
    fs.readdir = (path, options = {}) => answer('readdir', () => after(resolve(path, options.followSymlinks !== false), (key) => {
        if (key === DELEGATE || key === '' || key === null)
            return DELEGATE;
        const entry = entryAt(key);
        if (entry === undefined || entry === null)
            return DELEGATE;
        if (entry.type !== 'directory')
            return DELEGATE;
        if (!modeAllows(entry, 4, store.cred))
            return DELEGATE;
        return after(listingOf(key), (entries) => (entries === DELEGATE ? DELEGATE : byLocale(entries)));
    }), () => authority.readdir(path, options));
    /** The names in directory `key`; a tree walker gets the whole tree listed at once. */
    const listingOf = (key) => {
        const known = store.children(key);
        if (known !== undefined)
            return known;
        counts.treeListings++;
        return store.listTree(key)
            .then((whole) => (whole ? true : store.list(key)))
            .then((listed) => {
            const children = listed ? store.children(key) : undefined;
            return children === undefined ? DELEGATE : children;
        });
    };
    // The session lists a directory by name in locale order, and through a
    // descriptor in the filesystem's own (code unit) order: each is kept.
    const byLocale = (entries) => [...entries].sort((a, b) => a.name.localeCompare(b.name));
    const byCodeUnit = (entries) => [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    fs.readlink = (path) => answer('readlink', () => after(resolve(path, false), (key) => {
        if (key === DELEGATE || key === '')
            return DELEGATE;
        if (key === null)
            return null;
        const entry = entryAt(key);
        if (entry === undefined)
            return DELEGATE;
        return entry !== null && entry.type === 'symlink' && entry.target !== null ? entry.target : null;
    }), () => authority.readlink(path));
    fs.realpath = (path) => answer('realpath', () => after(resolve(path, true), (key) => {
        if (key === DELEGATE || key === '')
            return DELEGATE;
        if (key === null)
            throw fsError('ELOOP', 'realpath', path);
        const entry = entryAt(key);
        if (entry === undefined)
            return DELEGATE;
        if (entry === null)
            throw fsError('ENOENT', 'realpath', path);
        return '/' + key;
    }), () => authority.realpath(path));
    fs.open = (path, flags) => {
        const readOnly = !flags.write && !flags.create && !flags.truncate && !flags.append && !flags.exclusive;
        // A new or emptied file on the session's own filesystem: its writes are held (HeldWrite).
        const whole = !!flags.write && !flags.append && (!!flags.truncate || (!!flags.create && !!flags.exclusive));
        if (whole) {
            return after(changing('open', () => authority.open(path, flags)), (handle) => {
                const key = keyOf(handle.path);
                const parent = store.ready() ? store.entry(parentKey(key)) : undefined;
                if (parent && parent.type === 'directory' && parent.dev === store.device) {
                    writes.set(handle.id, { id: handle.id, key, path: handle.path, readable: !!flags.read, bytes: new Uint8Array(0), length: 0, position: 0 });
                }
                return handle;
            });
        }
        if (!readOnly)
            return changing('open', () => authority.open(path, flags));
        return answer('open', () => after(resolve(path, flags.followSymlinks !== false, true), (key) => {
            if (key === DELEGATE || key === '' || key === null)
                return DELEGATE;
            const entry = entryAt(key);
            if (entry === undefined || entry === null)
                return DELEGATE;
            if (entry.type === 'symlink')
                return DELEGATE;
            if (flags.directory && entry.type !== 'directory')
                throw fsError('ENOTDIR', 'open', path);
            if (entry.type === 'file' && entry.size > RESIDENT_OPEN_MAX_BYTES)
                return DELEGATE;
            if (!modeAllows(entry, 4, store.cred))
                throw fsError('EACCES', 'open', path);
            const handle = {
                id: nextHandle++,
                path: key,
                flags: {
                    read: true, write: false, append: false, create: false, exclusive: false,
                    directory: !!flags.directory, truncate: false, followSymlinks: flags.followSymlinks !== false,
                },
                position: 0,
                closed: false,
                key,
                entry,
                bytes: null,
            };
            handles.set(handle.id, handle);
            return handle;
        }), () => authority.open(path, flags));
    };
    fs.fstat = (handleId) => {
        const held = writes.get(handleId);
        if (held !== undefined) {
            delegated('fstat');
            return after(authority.fstat(handleId), (st) => ({ ...st, size: held.length }));
        }
        const handle = local(handleId);
        if (handle === undefined) {
            delegated('fstat');
            return authority.fstat(handleId);
        }
        // The name may now be another file: the descriptor's is the one it opened.
        const current = store.entry(handle.key);
        return statOf(current && current.ino === handle.entry.ino && current.dev === handle.entry.dev ? current : handle.entry);
    };
    fs.read = (handleId, offset, length) => {
        const held = writes.get(handleId);
        if (held !== undefined) {
            if (!held.readable)
                throw fsError('EBADF', 'read', held.path);
            counts.local++;
            const start = Math.min(offset ?? held.position, held.length);
            const chunk = held.bytes.slice(start, Math.min(held.length, start + length));
            if (offset === null)
                held.position = start + chunk.byteLength;
            return chunk;
        }
        const handle = local(handleId);
        if (handle === undefined) {
            delegated('read');
            return authority.read(handleId, offset, length);
        }
        if (handle.entry.type === 'directory')
            throw fsError('EISDIR', 'read', handle.path);
        return after(localBytes(handle), (bytes) => {
            const start = Math.min(offset ?? handle.position, bytes.byteLength);
            const chunk = bytes.subarray(start, Math.min(bytes.byteLength, start + length));
            if (offset === null)
                handle.position = start + chunk.byteLength;
            return chunk.slice();
        });
    };
    fs.seek = (handleId, offset, whence) => {
        const held = writes.get(handleId);
        if (held !== undefined) {
            counts.local++;
            const position = (whence === 'set' ? 0 : whence === 'current' ? held.position : held.length) + offset;
            if (position < 0)
                throw fsError('EINVAL', 'lseek', held.path);
            held.position = position;
            return position;
        }
        const handle = local(handleId);
        if (handle === undefined) {
            delegated('seek');
            return authority.seek(handleId, offset, whence);
        }
        const base = whence === 'set' ? 0 : whence === 'current' ? handle.position : handle.entry.size;
        const position = base + offset;
        if (position < 0)
            throw fsError('EINVAL', 'lseek', handle.path);
        handle.position = position;
        return position;
    };
    fs.close = (handleId) => {
        const held = writes.get(handleId);
        // The descriptor closes either way; a write the session refused is the close's error, as on a network filesystem.
        const closing = () => after(changing('close', () => authority.close(handleId)), () => {
            const failure = takeUnsettled(handleId);
            if (failure !== undefined)
                throw failure;
        });
        if (held !== undefined)
            return release(held).then(closing, closing);
        if (unsettled.has(handleId))
            return closing();
        const handle = local(handleId);
        if (handle === undefined)
            return changing('close', () => authority.close(handleId));
        handle.closed = true;
        handles.delete(handleId);
    };
    fs.readdirHandle = (handleId) => {
        const handle = local(handleId);
        if (handle === undefined) {
            delegated('readdirHandle');
            return authority.readdirHandle(handleId);
        }
        if (handle.entry.type !== 'directory')
            throw fsError('ENOTDIR', 'scandir', handle.path);
        return after(listingOf(handle.key), (entries) => {
            if (entries !== DELEGATE)
                return byCodeUnit(entries);
            // The store could not list it: the session lists the directory by name.
            delegated('readdirHandle');
            return after(authority.readdir('/' + handle.key), byCodeUnit);
        });
    };
    fs.setStatus = (handleId, status) => {
        const handle = local(handleId);
        if (handle === undefined) {
            delegated('setStatus');
            return authority.setStatus(handleId, status);
        }
        // A read-only description: O_APPEND has nothing to append to.
    };
    fs.fsync = (handleId) => {
        if (handleId !== undefined && local(handleId) !== undefined)
            return;
        // Synced means in the session: what is held goes now, and the descriptor writes through after.
        if (handleId === undefined) {
            return fs.settle().then((failures) => {
                if (failures.length > 0)
                    throw failures[0].error;
                return authority.fsync();
            });
        }
        const held = writes.get(handleId);
        const reported = () => {
            const failure = takeUnsettled(handleId);
            if (failure !== undefined)
                throw failure;
        };
        if (held !== undefined)
            return release(held).then(() => { reported(); return authority.fsync(handleId); }, () => reported());
        reported();
        delegated('fsync');
        return authority.fsync(handleId);
    };
    for (const name of ['ftruncate', 'fchmod', 'fchown', 'futimes', 'write', 'dup']) {
        const passed = Reflect.get(fs, name);
        if (typeof passed !== 'function')
            continue;
        Reflect.set(fs, name, (handleId, ...rest) => {
            // A descriptor this adapter opened is read-only and never the authority's.
            if (local(handleId) !== undefined)
                throw fsError('EBADF', name, String(handleId));
            // Anything but a write or a truncate of a held file sends what is held first.
            const held = writes.get(handleId);
            if (held !== undefined)
                return release(held).then(() => Reflect.apply(passed, fs, [handleId, ...rest]));
            return Reflect.apply(passed, fs, [handleId, ...rest]);
        });
    }
    fs.write = (handleId, offset, bytes) => {
        const held = writes.get(handleId);
        if (held === undefined) {
            if (local(handleId) !== undefined)
                throw fsError('EBADF', 'write', String(handleId));
            return changing('write', () => authority.write(handleId, offset, bytes));
        }
        counts.local++;
        const start = offset ?? held.position;
        const end = start + bytes.byteLength;
        grow(held, end);
        // A write past the end leaves zeros between, as the file would.
        if (start > held.length)
            held.bytes.fill(0, held.length, start);
        held.bytes.set(bytes, start);
        held.length = Math.max(held.length, end);
        if (offset === null)
            held.position = end;
        // Past the bound a process may hold, it goes to the session now and writes through after.
        if (heldBytes > FACET_OWN_WRITE_MEMORY_BYTES)
            return release(held).then(() => bytes.byteLength);
        return bytes.byteLength;
    };
    fs.ftruncate = (handleId, size) => {
        const held = writes.get(handleId);
        if (held === undefined) {
            if (local(handleId) !== undefined)
                throw fsError('EBADF', 'ftruncate', String(handleId));
            return changing('ftruncate', () => authority.ftruncate(handleId, size));
        }
        counts.local++;
        grow(held, size);
        if (size > held.length)
            held.bytes.fill(0, held.length, size);
        held.length = size;
    };
    return fs;
}
