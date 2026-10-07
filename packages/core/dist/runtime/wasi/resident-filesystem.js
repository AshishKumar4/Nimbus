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
 * it: a lookup, a stat, a directory listing and its descriptor, and a file's
 * bytes (which the codec holds for a read-only descriptor, its ResidentFd) are
 * answered from the store; anything that changes the filesystem, and anything
 * the store cannot vouch for, goes to the authority exactly as before. The
 * store is the process's one copy of file bytes, under its one budget: a
 * descriptor the codec answers itself pins the bytes it reads for its
 * lifetime (`pinContent`), charged to that budget, and past it the codec
 * opens the session's descriptor instead.
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
import { WASI_RESIDENT_FILE_CAP_BYTES } from '../../constants.js';
import { delegationHolder } from './delegation-holder.js';
/** A held write goes to the session in pieces of this size: each fits one call. */
const WRITE_PIECE_BYTES = 1024 * 1024;
/** Listings one call may take before it gives the question to the authority. */
const MAX_LISTINGS_PER_CALL = 64;
/** What this adapter answers itself is decided here: anything else is the authority's. */
const DELEGATE = Symbol('delegate');
/** The root of the namespace as the walk asks about it (the authority's rootStat, for what the walk reads). */
const ROOT_FOR_WALK = { type: 'directory', mode: 0o40755, uid: 0, gid: 0 };
/** The calls that can change the namespace or bytes: after one, the barrier is owed. */
const MUTATIONS = new Set([
    'writeFile', 'writeFileFrom', 'writeRange', 'truncate', 'utimes', 'chmod', 'chown', 'write', 'close', 'mkdir',
    'unlink', 'rmdir', 'rename', 'symlink', 'remove', 'copyFile', 'copyTree', 'ftruncate', 'fchmod', 'fchown',
    'futimes', 'writeBatch', 'writeStream',
]);
/** Those that name their file by descriptor; every other one names a path, and may name a held file. */
const DESCRIPTOR_MUTATIONS = new Set(['write', 'close', 'ftruncate', 'fchmod', 'fchown', 'futimes']);
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
const identity = (dev, ino) => `${dev}:${ino}`;
export function residentFilesystem(session, resident, delegation) {
    const counts = { local: 0, delegated: {}, lookups: 0, listings: 0, treeListings: 0, fills: 0, filledBytes: 0, barriers: 0, waitMs: 0, pinnedBytes: 0, pins: 0 };
    // Every wait on the session is timed where it leaves: the authority's calls
    // and the store's listings, fills and barriers. A facet's clock moves only
    // across I/O, so this is the part of a run's wall time the filesystem cost.
    const timed = (value) => {
        if (!(value instanceof Promise))
            return value;
        const started = Date.now();
        return value.finally(() => { counts.waitMs += Date.now() - started; });
    };
    // The subtrees this process holds, when it may hold any (it waits in its
    // syscalls): what it decided there is answered here and sent later.
    let holder = null;
    const authority = new Proxy(session, {
        get(target, name, receiver) {
            const value = Reflect.get(target, name, receiver);
            if (typeof value !== 'function')
                return value;
            // Whatever the session is asked, it has what this process decided first.
            // A refusal it met is the next sync's to report, not this call's.
            return (...args) => (holder !== null && holder.pending()
                ? timed(holder.send().then(() => Reflect.apply(value, target, args)))
                : timed(Reflect.apply(value, target, args)));
        },
    });
    const store = {
        get device() { return resident.device; },
        get cred() { return resident.cred; },
        ready: () => resident.ready(),
        // What this process decided in a subtree it holds is what it sees there.
        entry: (key) => {
            const own = holder?.entry(key);
            return own !== undefined ? own : resident.entry(key);
        },
        children: (key) => (holder === null ? resident.children(key) : holder.children(key, resident.children(key))),
        list: (key) => timed(resident.list(key)),
        lookup: (keys, content) => timed(resident.lookup(keys, content)),
        listTree: (key) => timed(resident.listTree(key)),
        content: (key) => resident.content(key),
        fill: (key, entry) => timed(resident.fill(key, entry)),
        barrier: () => timed(resident.barrier()),
        reserve: (bytes) => resident.reserve(bytes),
        release: (bytes) => resident.release(bytes),
    };
    const delegated = (name) => { counts.delegated[name] = (counts.delegated[name] ?? 0) + 1; };
    /** The barrier is owed: set by a change or by input, cleared only by a barrier that lands. */
    let owed = false;
    if (delegation !== undefined) {
        holder = delegationHolder({
            session: delegation.session,
            // The holder reads the store itself, its own decisions aside.
            store: {
                get device() { return resident.device; },
                get cred() { return resident.cred; },
                entry: (key) => resident.entry(key),
                children: (key) => resident.children(key),
            },
            isHomeRoot: delegation.isHomeRoot,
            ...(delegation.grantAfter === undefined ? {} : { grantAfter: delegation.grantAfter }),
            ...(delegation.grantInos === undefined ? {} : { grantInos: delegation.grantInos }),
            ...(delegation.journal === undefined ? {} : { journal: delegation.journal }),
            // What it sent changed the session: the store catches up before it answers next.
            sent: () => { owed = true; },
        });
    }
    /** The session's descriptors this process opened read-only: closing one changes nothing, so it owes no barrier. */
    const readers = new Set();
    /** Of those, the directories, and where their listing is, once their fstat named them. */
    const pendingDirectories = new Map();
    const directories = new Map();
    /** Bytes pinned for the codec's own descriptors (pinContent). */
    const pins = new Map();
    /** A write-through description's reader: the session's read-only descriptor of its file, opened at its first read. */
    const throughReaders = new Map();
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
    /** Where an open directory's listing is, while its name still leads to the directory the session opened. */
    const directoryKey = (handleId) => {
        const open = directories.get(handleId);
        if (open === undefined)
            return undefined;
        const entry = store.entry(open.key);
        return entry && entry.type === 'directory' && entry.dev === open.dev && entry.ino === open.ino ? open.key : undefined;
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
            const key = directoryKey(path.directory);
            if (key === undefined)
                return DELEGATE;
            root = key;
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
        // A file this process writes through has the size its writes gave it.
        if (entry === null || entry.type !== 'file')
            return entry;
        const size = holder?.writing(entry.ino);
        return size === undefined ? entry : { ...entry, size };
    };
    /**
     * A file's bytes: what this process decided for it, else the store's,
     * fetched into it. Undefined when only the authority can read them (a file
     * this process writes through: the authority has its writes first).
     */
    const contentOf = (key, entry) => {
        const decided = holder?.content(entry);
        if (decided !== undefined)
            return decided;
        if (holder?.writing(entry.ino) !== undefined)
            return undefined;
        const keep = (bytes) => (bytes === null || bytes === undefined || bytes.byteLength !== entry.size ? undefined : bytes);
        const held = store.content(key);
        if (held !== undefined && held.byteLength === entry.size)
            return held;
        counts.fills++;
        counts.filledBytes += entry.size;
        return store.fill(key, entry).then(keep);
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
            counts.barriers++;
            return store.barrier().then((ok) => {
                // Still owed until a barrier lands: this call is the session's, and so is the next one's question.
                if (!ok || !store.ready()) {
                    delegated(name);
                    return remote();
                }
                owed = false;
                return after(local(), settle);
            });
        }
        return after(local(), settle);
    };
    /**
     * A mutation the holder may decide (a subtree it holds, or one it takes
     * for this): `local` with the barrier taken when owed, its answer counted
     * as local; DELEGATE (or false/undefined from the holder) hands it on.
     */
    const decide = (name, local) => {
        if (holder === null || !store.ready())
            return DELEGATE;
        const settle = (value) => {
            if (value !== DELEGATE)
                counts.local++;
            return value;
        };
        if (owed) {
            counts.barriers++;
            return store.barrier().then((ok) => {
                if (!ok || !store.ready())
                    return DELEGATE;
                owed = false;
                return after(local(), settle);
            });
        }
        return after(local(), settle);
    };
    /** The resolved key of `path` for a mutation the holder may decide, or DELEGATE. */
    const keyFor = (path, follow) => after(resolve(path, follow), (key) => (typeof key === 'string' && key !== '' ? key : DELEGATE));
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
        // The authority has what this process logged before it (its proxy flushes first).
        const mutates = MUTATIONS.has(name);
        Reflect.set(fs, name, mutates
            ? (...args) => changing(name, () => call(...args))
            : (...args) => { delegated(name); return call(...args); });
    }
    Reflect.set(fs, 'synchronous', authority.synchronous);
    fs.inbound = () => { owed = true; };
    fs.holding = () => holder?.pending() ?? false;
    // What leaves the process is preceded by everything it logged.
    fs.flush = async () => { await holder?.flush(); };
    fs.settle = async () => {
        const failures = [];
        // The run's end: what it logged is answered, and the subtrees it held are given back.
        if (holder !== null) {
            try {
                await holder.settle();
            }
            catch (error) {
                failures.push({ path: '/', dev: 0, ino: 0, error });
            }
        }
        return failures;
    };
    // A sync of a file through any descriptor: everything this process logged is answered first.
    fs.syncInode = () => (holder !== null && holder.pending() ? holder.flush() : undefined);
    fs.stats = () => ({
        ...counts,
        delegated: { ...counts.delegated },
        pins: pins.size,
        pinnedBytes: [...pins.values()].reduce((total, pin) => total + pin.bytes.byteLength, 0),
        ...(holder === null ? {} : { client: holder.client.stats() }),
    });
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
    /** The session is to answer for this file (the authority has what this process logged first). */
    const toSession = (_entry) => DELEGATE;
    fs.pinContent = (path, stat) => answer('pinContent', () => after(resolve(path, true, true), (key) => {
        if (key === DELEGATE || key === '' || key === null)
            return null;
        const entry = entryAt(key);
        // Only the file the caller stat'd, at the revision it stat'd: anything else is the session's to open.
        if (!entry || entry.type !== 'file' || entry.dev !== stat.dev || entry.ino !== stat.ino || entry.size > WASI_RESIDENT_FILE_CAP_BYTES)
            return null;
        if (!modeAllows(entry, 4, store.cred))
            return null;
        // A file this process writes through is the session's to read (its writes are answered there first).
        if (holder?.writing(entry.ino) !== undefined || entry.revision !== stat.revision)
            return null;
        const pinKey = `${identity(entry.dev, entry.ino)}:${entry.revision}`;
        const pinned = (pin) => {
            pin.holders++;
            let released = false;
            return {
                bytes: pin.bytes,
                release: () => {
                    if (released)
                        return;
                    released = true;
                    if (--pin.holders > 0)
                        return;
                    pins.delete(pinKey);
                    store.release(pin.bytes.byteLength);
                },
            };
        };
        const existing = pins.get(pinKey);
        if (existing !== undefined)
            return pinned(existing);
        return after(contentOf(key, entry), (bytes) => {
            if (bytes === undefined || !store.reserve(bytes.byteLength))
                return null;
            const pin = { bytes, holders: 0 };
            pins.set(pinKey, pin);
            return pinned(pin);
        });
    }), () => null);
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
        if (entry.type !== 'file' || entry.size > WASI_RESIDENT_FILE_CAP_BYTES)
            return toSession(entry);
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
        if (!readOnly && holder !== null) {
            // A file made or emptied in a subtree this process holds is decided here.
            const local = decide('open', () => after(keyFor(path, true), (key) => (key === DELEGATE ? DELEGATE
                : after(holder.open(key, typeof path === 'string' ? path : path.path, flags), (handle) => handle ?? DELEGATE))));
            return after(local, (handle) => (handle === DELEGATE ? openOnSession(path, flags) : handle));
        }
        return openOnSession(path, flags);
    };
    const openOnSession = (path, flags) => {
        const readOnly = !flags.write && !flags.create && !flags.truncate && !flags.append && !flags.exclusive;
        if (!readOnly) {
            // A file of the session's own filesystem is opened to write through
            // the process's client (an open call, answered with its stat), and
            // written through by its number; a directory, a file the store cannot
            // place, or one on a mount is the session's descriptor.
            const through = () => {
                if (holder === null || !store.ready() || flags.directory)
                    return DELEGATE;
                return after(keyFor(path, false), (key) => {
                    if (key === DELEGATE)
                        return DELEGATE;
                    const there = entryAt(key);
                    if (there === undefined || there?.type === 'directory')
                        return DELEGATE;
                    delegated('open');
                    return after(holder.openThrough(key, typeof path === 'string' ? path : path.path, flags), (handle) => { owed = true; return handle; });
                });
            };
            return after(through(), (handle) => (handle === DELEGATE ? changing('open', () => authority.open(path, flags)) : handle));
        }
        // A read-only open is the session's descriptor (it has what this process logged first).
        delegated('open');
        return after(authority.open(path, flags), (handle) => {
            readers.add(handle.id);
            pendingDirectories.set(handle.id, keyOf(handle.path));
            return handle;
        });
    };
    fs.fstat = (handleId) => {
        if (holder?.owns(handleId)) {
            // Written through: the session's live stat of its file, once what it
            // wrote is there; a name that no longer leads to its file is gone (nlink 0).
            if (holder.through(handleId))
                return liveThrough(handleId);
            counts.local++;
            return statOf(holder.fstat(handleId));
        }
        delegated('fstat');
        return after(authority.fstat(handleId), (stat) => {
            // A directory opened read-only is listed here while its name still leads to it.
            const key = pendingDirectories.get(handleId);
            if (key !== undefined) {
                pendingDirectories.delete(handleId);
                if (stat.type === 'directory' && stat.dev === store.device)
                    directories.set(handleId, { key, dev: stat.dev, ino: stat.ino });
            }
            return stat;
        });
    };
    /** A write-through description's stat: the session's, by its file's name while that leads to it. */
    const liveThrough = async (handleId) => {
        const own = holder.fstat(handleId);
        await holder.send();
        delegated('stat');
        const live = await authority.stat('/' + holder.keyOf(handleId), { followSymlinks: false });
        return live !== null && live.ino === own.ino ? live : statOf({ ...own, nlink: 0 });
    };
    /** The session's bytes of `key` for write-through description `handleId`, by its own read-only descriptor of the file. */
    const readThrough = (handleId) => async (key, at, length) => {
        let reader = throughReaders.get(handleId);
        if (reader === undefined) {
            delegated('open');
            reader = (await authority.open('/' + key, { read: true })).id;
            throughReaders.set(handleId, reader);
        }
        delegated('read');
        return authority.read(reader, at, length);
    };
    fs.read = (handleId, offset, length) => {
        if (holder?.owns(handleId)) {
            if (holder.through(handleId))
                return holder.readThrough(handleId, offset, length, readThrough(handleId));
            counts.local++;
            return holder.read(handleId, offset, length);
        }
        delegated('read');
        return authority.read(handleId, offset, length);
    };
    fs.seek = (handleId, offset, whence) => {
        if (holder?.owns(handleId)) {
            counts.local++;
            return holder.seek(handleId, offset, whence);
        }
        delegated('seek');
        return authority.seek(handleId, offset, whence);
    };
    fs.write = (handleId, offset, bytes) => {
        if (holder?.owns(handleId)) {
            counts.local++;
            return holder.write(handleId, offset, bytes);
        }
        return changing('write', () => authority.write(handleId, offset, bytes));
    };
    fs.ftruncate = (handleId, size) => {
        if (holder?.owns(handleId)) {
            counts.local++;
            holder.ftruncate(handleId, size);
            return;
        }
        return changing('ftruncate', () => authority.ftruncate(handleId, size));
    };
    fs.close = (handleId) => {
        // A descriptor of the holder's closes here: what it wrote is in the log.
        if (holder?.owns(handleId)) {
            counts.local++;
            holder.close(handleId);
            const reader = throughReaders.get(handleId);
            if (reader === undefined)
                return;
            throughReaders.delete(handleId);
            delegated('close');
            return authority.close(reader);
        }
        if (readers.delete(handleId)) {
            pendingDirectories.delete(handleId);
            directories.delete(handleId);
            delegated('close');
            return authority.close(handleId);
        }
        return changing('close', () => authority.close(handleId));
    };
    fs.readdirHandle = (handleId) => answer('readdirHandle', () => {
        const key = directoryKey(handleId);
        if (key === undefined)
            return DELEGATE;
        return after(listingOf(key), (entries) => (entries === DELEGATE ? DELEGATE : byCodeUnit(entries)));
    }, () => authority.readdirHandle(handleId));
    fs.fsync = (handleId) => {
        // Synced means in the session: everything this process logged is answered first.
        if (handleId !== undefined && holder?.owns(handleId))
            return holder.flush();
        const synced = async () => {
            await holder?.flush();
            delegated('fsync');
            await authority.fsync(handleId);
        };
        return synced();
    };
    for (const name of ['fchmod', 'fchown', 'futimes', 'dup']) {
        const passed = Reflect.get(fs, name);
        if (typeof passed !== 'function')
            continue;
        Reflect.set(fs, name, (handleId, ...rest) => {
            if (holder?.owns(handleId))
                return holderDescriptorCall(name, handleId, rest);
            return Reflect.apply(passed, fs, [handleId, ...rest]);
        });
    }
    /**
     * fchmod, futimes, fchown and dup of a descriptor of the holder's: decided
     * here where the holder decides them, else by the file's name at the
     * session, once what was decided is sent.
     */
    const holderDescriptorCall = (name, handleId, rest) => {
        const key = holder.keyOf(handleId);
        if (name === 'dup')
            return holder.dup(handleId);
        const attrs = name === 'fchmod' ? { mode: Number(rest[0]) }
            : name === 'futimes' && typeof rest[0] === 'number' && typeof rest[1] === 'number' ? { atime: rest[0], mtime: rest[1] }
                : null;
        const bySession = () => holder.flush().then(() => {
            const path = '/' + key;
            if (name === 'fchmod')
                return fs.chmod(path, Number(rest[0]));
            if (name === 'fchown')
                return fs.chown(path, rest[0], rest[1]);
            return fs.utimes(path, rest[0], rest[1]);
        });
        if (attrs === null)
            return bySession();
        return after(holder.setattr(key, attrs), (done) => (done ? undefined : bySession()));
    };
    /**
     * A change by name no held subtree decides: an op of the process's client
     * when the store places the name (ordered with everything it logged,
     * answered before the call returns), else the session's call (its proxy
     * sends what the process logged first).
     */
    const byClient = (name, op) => {
        delegated(name);
        return holder.client.submit(op).then(() => { owed = true; }, (error) => { owed = true; throw error; });
    };
    const pathOf = (path) => (typeof path === 'string' ? path : path.path);
    /** Where the store places `path` (its directory resolved, the name itself not followed), current first; DELEGATE when it cannot say. */
    const placedKey = (path) => {
        if (holder === null || !store.ready())
            return DELEGATE;
        if (!owed)
            return keyFor(path, false);
        counts.barriers++;
        return store.barrier().then((ok) => {
            if (!ok || !store.ready())
                return DELEGATE;
            owed = false;
            return keyFor(path, false);
        });
    };
    // Changes by name a held subtree holds are decided here; any other is the session's, through the client.
    const bySessionMkdir = fs.mkdir;
    fs.mkdir = (path, options) => {
        if (holder === null || options?.recursive)
            return bySessionMkdir(path, options);
        const mode = options?.mode ?? 0o777;
        let named;
        const local = decide('mkdir', () => after(keyFor(path, false), (key) => {
            if (key === DELEGATE)
                return DELEGATE;
            named = key;
            return after(holder.mkdir(key, pathOf(path), mode), (done) => (done ? undefined : DELEGATE));
        }));
        return after(local, (done) => (done !== DELEGATE ? undefined
            : named !== undefined ? byClient('mkdir', { type: 'call', call: { call: 'mkdir', path: named, mode } }) : bySessionMkdir(path, options)));
    };
    const bySessionUnlink = fs.unlink;
    fs.unlink = (path) => {
        if (holder === null)
            return bySessionUnlink(path);
        let named;
        const local = decide('unlink', () => after(keyFor(path, false), (key) => {
            if (key === DELEGATE)
                return DELEGATE;
            named = key;
            return after(holder.unlink(key, pathOf(path)), (done) => (done ? undefined : DELEGATE));
        }));
        return after(local, (done) => (done !== DELEGATE ? undefined
            : named !== undefined ? byClient('unlink', { type: 'call', call: { call: 'unlink', path: named } }) : bySessionUnlink(path)));
    };
    const bySessionRename = fs.rename;
    fs.rename = (from, to) => {
        if (holder === null)
            return bySessionRename(from, to);
        let names;
        const local = decide('rename', () => after(keyFor(from, false), (source) => (source === DELEGATE ? DELEGATE
            : after(keyFor(to, false), (target) => {
                if (target === DELEGATE)
                    return DELEGATE;
                names = [source, target];
                return after(holder.rename(source, target, pathOf(from)), (done) => (done ? undefined : DELEGATE));
            }))));
        return after(local, (done) => (done !== DELEGATE ? undefined
            : names !== undefined ? byClient('rename', { type: 'rename', from: names[0], to: names[1] }) : bySessionRename(from, to)));
    };
    // Nothing of these is decided here: by the client when the store places the name.
    const byName = (name, passed, pathAt, op) => (...args) => {
        if (holder === null)
            return passed(...args);
        const placed = placedKey(args[pathAt]);
        return after(placed, (key) => (key === DELEGATE ? passed(...args) : byClient(name, op(key, args))));
    };
    const bySessionRmdir = fs.rmdir;
    fs.rmdir = byName('rmdir', (path) => bySessionRmdir(path), 0, (key) => ({ type: 'call', call: { call: 'rmdir', path: key } }));
    const bySessionSymlink = fs.symlink;
    fs.symlink = byName('symlink', (target, path) => bySessionSymlink(target, path), 1, (key, [target]) => ({ type: 'call', call: { call: 'symlink', path: key, target } }));
    return fs;
}
