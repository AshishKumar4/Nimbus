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
            return (...args) => (holder !== null && holder.pending()
                ? timed(holder.flush().then(() => Reflect.apply(value, target, args)))
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
    /** Writes held for the session's descriptors, by descriptor; their buffers are charged to the store's budget. */
    const writes = new Map();
    /** Held writes the session refused, by descriptor, until reported (by that descriptor's close or fsync, or by settle). */
    const unsettled = new Map();
    /** The session's descriptors this process opened read-only: closing one changes nothing, so it owes no barrier. */
    const readers = new Set();
    /** Of those, the directories, and where their listing is, once their fstat named them. */
    const pendingDirectories = new Map();
    const directories = new Map();
    /** The identity of every session descriptor this process has fstat'd: a sync through it reports the file's refusals. */
    const identities = new Map();
    /** Bytes pinned for the codec's own descriptors (pinContent). */
    const pins = new Map();
    /** The held write of the file (dev, ino), if this process is writing it. */
    const heldFor = (dev, ino) => {
        let found;
        for (const held of writes.values())
            if (held.ino === ino && held.dev === dev)
                found = held;
        return found;
    };
    /**
     * Room for `held` to reach `length` bytes, or false when that would pass
     * what one held file may take or what the store's budget has left: the
     * file then goes to the session and is written there.
     */
    const room = (held, length) => {
        if (length <= held.bytes.byteLength)
            return true;
        if (length > WASI_RESIDENT_FILE_CAP_BYTES)
            return false;
        const size = Math.min(WASI_RESIDENT_FILE_CAP_BYTES, Math.max(length, held.bytes.byteLength * 2, 4096));
        if (!store.reserve(size - held.bytes.byteLength))
            return false;
        const next = new Uint8Array(size);
        next.set(held.bytes.subarray(0, held.length));
        held.bytes = next;
        return true;
    };
    /** Held versions are numbered across every held write of this process. */
    let versions = 0;
    /** A held file changed: a reader's copy of the old content is no longer the file's. */
    const changed = (held) => {
        held.version = ++versions;
    };
    /**
     * Send what `held` holds through its descriptor, a piece at a time, and stop
     * holding it: the descriptor is the session's again, at the position the
     * program left it at. A refusal is kept for this descriptor until reported.
     */
    const release = async (held, closing = false) => {
        writes.delete(held.id);
        store.release(held.bytes.byteLength);
        try {
            for (let at = 0; at < held.length; at += WRITE_PIECE_BYTES) {
                await authority.write(held.id, at, held.bytes.slice(at, Math.min(held.length, at + WRITE_PIECE_BYTES)));
            }
            // A descriptor about to close has no position to keep: one trip fewer per file.
            if (!closing && held.position !== 0)
                await authority.seek(held.id, held.position, 'set');
        }
        catch (error) {
            unsettled.set(held.id, { path: held.path, dev: held.dev, ino: held.ino, error });
        }
        finally {
            owed = true;
        }
    };
    /** Send every held write (those matching `which`) to the session. Refusals stay recorded until reported. */
    const flush = async (which = () => true) => {
        for (const held of [...writes.values()])
            if (which(held))
                await release(held);
    };
    /** Report, once, a refusal an earlier release left on `handleId`. */
    const reportUnsettled = (handleId) => {
        const failure = unsettled.get(handleId);
        if (failure === undefined)
            return;
        unsettled.delete(handleId);
        throw failure.error;
    };
    /**
     * A sync of the file (dev, ino) through any descriptor: what is held for it
     * goes first, and a refusal any of its writers met is this sync's answer,
     * as on Linux every descriptor of a file sees its writeback error. The
     * writer's own close or the run's settle still reports it too.
     */
    const syncIdentity = (dev, ino) => {
        const refusal = () => {
            for (const failure of unsettled.values())
                if (failure.dev === dev && failure.ino === ino)
                    throw failure.error;
        };
        if (heldFor(dev, ino) === undefined)
            return refusal();
        return flush((held) => held.dev === dev && held.ino === ino).then(refusal);
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
        // What this process has written to this file and not yet sent is what it reads back.
        if (entry === null || entry.type !== 'file')
            return entry;
        const held = heldFor(entry.dev, entry.ino);
        return held === undefined ? entry : { ...entry, size: held.length };
    };
    /**
     * A file's bytes: a copy of what this process is writing to it, else the
     * store's, fetched into it. Undefined when only the authority can read
     * them. A copy of a held file belongs to the caller (pinContent keeps it
     * in its pin, charged, for as long as a descriptor holds it).
     */
    const contentOf = (key, entry) => {
        const decided = holder?.content(entry);
        if (decided !== undefined)
            return decided;
        const writing = heldFor(entry.dev, entry.ino);
        if (writing !== undefined)
            return writing.bytes.slice(0, writing.length);
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
        const mutates = MUTATIONS.has(name);
        // A change by path (a rename of the file being written, a copy of it)
        // acts on what the session has: what is held goes first.
        const byPath = mutates && !DESCRIPTOR_MUTATIONS.has(name);
        Reflect.set(fs, name, mutates
            ? (...args) => (byPath && writes.size > 0
                ? flush().then(() => changing(name, () => call(...args)))
                : changing(name, () => call(...args)))
            : (...args) => { delegated(name); return call(...args); });
    }
    Reflect.set(fs, 'synchronous', authority.synchronous);
    fs.inbound = () => { owed = true; };
    fs.holding = () => writes.size > 0 || (holder?.pending() ?? false);
    // What leaves the process is preceded by everything it wrote: its held
    // writes, and what it decided in the subtrees it holds.
    fs.flush = () => flush().then(() => holder?.flush());
    fs.settle = async () => {
        await flush();
        const failures = [...unsettled.values()];
        unsettled.clear();
        // The run's end: what it decided is sent, and the subtrees it held are given back.
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
    fs.syncInode = (dev, ino) => syncIdentity(dev, ino);
    fs.stats = () => ({
        ...counts,
        delegated: { ...counts.delegated },
        pins: pins.size,
        pinnedBytes: [...pins.values()].reduce((total, pin) => total + pin.bytes.byteLength, 0),
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
    /** The session is to answer for this file: when this process holds writes to it, they go first. */
    const toSession = (entry) => {
        if (heldFor(entry.dev, entry.ino) === undefined)
            return DELEGATE;
        return flush((held) => held.dev === entry.dev && held.ino === entry.ino).then(() => DELEGATE);
    };
    fs.pinContent = (path, stat) => answer('pinContent', () => after(resolve(path, true, true), (key) => {
        if (key === DELEGATE || key === '' || key === null)
            return null;
        const entry = entryAt(key);
        // Only the file the caller stat'd, at the revision it stat'd: anything else is the session's to open.
        if (!entry || entry.type !== 'file' || entry.dev !== stat.dev || entry.ino !== stat.ino || entry.size > WASI_RESIDENT_FILE_CAP_BYTES)
            return null;
        if (!modeAllows(entry, 4, store.cred))
            return null;
        const writing = heldFor(entry.dev, entry.ino);
        if (writing === undefined && entry.revision !== stat.revision)
            return null;
        const pinKey = writing === undefined ? `${identity(entry.dev, entry.ino)}:${entry.revision}` : `held:${writing.version}`;
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
            // Whatever this process holds is the file's content before a writer
            // opens it: a second r+ reads it, and a second O_TRUNC empties it.
            const opening = () => changing('open', () => authority.open(path, flags));
            const opened = writes.size > 0 ? flush().then(opening) : opening();
            // A new or emptied file on the session's own filesystem: its writes are held (HeldWrite).
            const whole = !!flags.write && !flags.append && (!!flags.truncate || (!!flags.create && !!flags.exclusive));
            if (!whole || !store.ready())
                return opened;
            return after(opened, (handle) => after(authority.fstat(handle.id), (stat) => {
                delegated('fstat');
                identities.set(handle.id, identity(stat.dev, stat.ino));
                if (stat.type === 'file' && stat.dev === store.device) {
                    writes.set(handle.id, {
                        id: handle.id, path: handle.path, dev: stat.dev, ino: stat.ino, readable: !!flags.read,
                        bytes: new Uint8Array(0), length: 0, position: 0, version: ++versions,
                    });
                }
                return handle;
            }));
        }
        // A read-only open is the session's descriptor; a file this process is
        // writing goes to the session first, so the descriptor reads all of it.
        const opening = () => after(authority.open(path, flags), (handle) => {
            readers.add(handle.id);
            pendingDirectories.set(handle.id, keyOf(handle.path));
            return handle;
        });
        delegated('open');
        return writes.size > 0 ? flush().then(opening) : opening();
    };
    fs.fstat = (handleId) => {
        if (holder?.owns(handleId)) {
            counts.local++;
            return statOf(holder.fstat(handleId));
        }
        delegated('fstat');
        return after(authority.fstat(handleId), (stat) => {
            identities.set(handleId, identity(stat.dev, stat.ino));
            // The session's stat as it is now (a peer's unlink, chmod or rename
            // shows), with what this process holds for the file as its size.
            const held = writes.get(handleId);
            if (held !== undefined)
                return { ...stat, size: held.length };
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
    fs.read = (handleId, offset, length) => {
        if (holder?.owns(handleId)) {
            counts.local++;
            return holder.read(handleId, offset, length);
        }
        const held = writes.get(handleId);
        if (held === undefined) {
            delegated('read');
            return authority.read(handleId, offset, length);
        }
        if (!held.readable)
            throw fsError('EBADF', 'read', held.path);
        counts.local++;
        const start = Math.min(offset ?? held.position, held.length);
        const chunk = held.bytes.slice(start, Math.min(held.length, start + length));
        if (offset === null)
            held.position = start + chunk.byteLength;
        return chunk;
    };
    fs.seek = (handleId, offset, whence) => {
        if (holder?.owns(handleId)) {
            counts.local++;
            return holder.seek(handleId, offset, whence);
        }
        const held = writes.get(handleId);
        if (held === undefined) {
            delegated('seek');
            return authority.seek(handleId, offset, whence);
        }
        counts.local++;
        const position = (whence === 'set' ? 0 : whence === 'current' ? held.position : held.length) + offset;
        if (position < 0)
            throw fsError('EINVAL', 'lseek', held.path);
        held.position = position;
        return position;
    };
    fs.write = (handleId, offset, bytes) => {
        if (holder?.owns(handleId)) {
            counts.local++;
            return holder.write(handleId, offset, bytes);
        }
        const held = writes.get(handleId);
        if (held === undefined)
            return changing('write', () => authority.write(handleId, offset, bytes));
        const start = offset ?? held.position;
        const end = start + bytes.byteLength;
        if (!room(held, end)) {
            // Past what may be held: what is held goes now, and this write after it.
            return release(held).then(() => {
                reportUnsettled(handleId);
                return changing('write', () => authority.write(handleId, offset, bytes));
            });
        }
        counts.local++;
        changed(held);
        // A write past the end leaves zeros between, as the file would.
        if (start > held.length)
            held.bytes.fill(0, held.length, start);
        held.bytes.set(bytes, start);
        held.length = Math.max(held.length, end);
        if (offset === null)
            held.position = end;
        return bytes.byteLength;
    };
    fs.ftruncate = (handleId, size) => {
        if (holder?.owns(handleId)) {
            counts.local++;
            holder.ftruncate(handleId, size);
            return;
        }
        const held = writes.get(handleId);
        if (held === undefined)
            return changing('ftruncate', () => authority.ftruncate(handleId, size));
        if (!room(held, size)) {
            return release(held).then(() => {
                reportUnsettled(handleId);
                return changing('ftruncate', () => authority.ftruncate(handleId, size));
            });
        }
        counts.local++;
        changed(held);
        if (size > held.length)
            held.bytes.fill(0, held.length, size);
        held.length = size;
    };
    fs.close = (handleId) => {
        // A descriptor of the holder's closes here: what it wrote is sent with the log.
        if (holder?.owns(handleId)) {
            counts.local++;
            holder.close(handleId);
            return;
        }
        identities.delete(handleId);
        const held = writes.get(handleId);
        // The descriptor closes either way; a write the session refused is the close's error, as on a network filesystem.
        const closing = () => after(changing('close', () => authority.close(handleId)), () => reportUnsettled(handleId));
        if (held !== undefined)
            return release(held, true).then(closing);
        if (unsettled.has(handleId))
            return closing();
        if (readers.delete(handleId)) {
            pendingDirectories.delete(handleId);
            directories.delete(handleId);
            delegated('close');
            return authority.close(handleId);
        }
        return closing();
    };
    fs.readdirHandle = (handleId) => answer('readdirHandle', () => {
        const key = directoryKey(handleId);
        if (key === undefined)
            return DELEGATE;
        return after(listingOf(key), (entries) => (entries === DELEGATE ? DELEGATE : byCodeUnit(entries)));
    }, () => authority.readdirHandle(handleId));
    fs.fsync = (handleId) => {
        // Synced means in the session: what this process decided goes first.
        if (handleId !== undefined && holder?.owns(handleId))
            return holder.flush();
        if (handleId === undefined && holder !== null)
            return holder.flush().then(() => syncAll());
        return syncOne(handleId);
    };
    const syncAll = () => flush().then(() => {
        const failure = unsettled.values().next();
        if (!failure.done)
            throw failure.value.error;
        return authority.fsync();
    });
    const syncOne = (handleId) => {
        if (handleId === undefined) {
            // sync(2) over every file: whatever any writer met is its answer (and still its writer's).
            return flush().then(() => {
                const failure = unsettled.values().next();
                if (!failure.done)
                    throw failure.value.error;
                return authority.fsync();
            });
        }
        // Synced means in the session: what is held goes now, and the descriptor writes through after.
        const held = writes.get(handleId);
        const synced = () => {
            reportUnsettled(handleId);
            const known = identities.get(handleId);
            const [dev, ino] = known === undefined ? [NaN, NaN] : known.split(':').map(Number);
            return after(known === undefined ? undefined : syncIdentity(dev, ino), () => { delegated('fsync'); return authority.fsync(handleId); });
        };
        return held === undefined ? synced() : release(held).then(synced);
    };
    for (const name of ['fchmod', 'fchown', 'futimes', 'dup']) {
        const passed = Reflect.get(fs, name);
        if (typeof passed !== 'function')
            continue;
        Reflect.set(fs, name, (handleId, ...rest) => {
            if (holder?.owns(handleId))
                return holderDescriptorCall(name, handleId, rest);
            // Anything but a write or a truncate of a held file sends what is held first.
            const held = writes.get(handleId);
            if (held !== undefined)
                return release(held).then(() => { reportUnsettled(handleId); return Reflect.apply(passed, fs, [handleId, ...rest]); });
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
    // Changes by name a held subtree holds are decided here; any other is the session's.
    const bySessionMkdir = fs.mkdir;
    fs.mkdir = (path, options) => {
        if (holder === null || options?.recursive)
            return bySessionMkdir(path, options);
        const local = decide('mkdir', () => after(keyFor(path, false), (key) => (key === DELEGATE ? DELEGATE
            : after(holder.mkdir(key, typeof path === 'string' ? path : path.path, options?.mode ?? 0o777), (done) => (done ? undefined : DELEGATE)))));
        return after(local, (done) => (done === DELEGATE ? bySessionMkdir(path, options) : undefined));
    };
    const bySessionUnlink = fs.unlink;
    fs.unlink = (path) => {
        if (holder === null)
            return bySessionUnlink(path);
        const local = decide('unlink', () => after(keyFor(path, false), (key) => (key === DELEGATE ? DELEGATE
            : after(holder.unlink(key, typeof path === 'string' ? path : path.path), (done) => (done ? undefined : DELEGATE)))));
        return after(local, (done) => (done === DELEGATE ? bySessionUnlink(path) : undefined));
    };
    const bySessionRename = fs.rename;
    fs.rename = (from, to) => {
        if (holder === null)
            return bySessionRename(from, to);
        const local = decide('rename', () => after(keyFor(from, false), (source) => (source === DELEGATE ? DELEGATE
            : after(keyFor(to, false), (target) => (target === DELEGATE ? DELEGATE
                : after(holder.rename(source, target, typeof from === 'string' ? from : from.path), (done) => (done ? undefined : DELEGATE)))))));
        return after(local, (done) => (done === DELEGATE ? bySessionRename(from, to) : undefined));
    };
    return fs;
}
