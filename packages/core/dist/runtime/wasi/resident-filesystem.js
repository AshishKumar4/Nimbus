/**
 * A WASI process's filesystem, answered from the process's own copy of the
 * namespace where that copy can answer, and by the authority everywhere else.
 *
 * Every filesystem syscall a guest makes is a call to the session: measured
 * on a throwaway (2026-10-05), 5.9-12.7 ms for one `os.stat` from Python, so
 * a program that stats a tree pays for each name with a round trip. The
 * process already carries a store for names and bytes
 * (worker vfs/resident, the one a node process reads its
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
import { fsError, walkBeneath } from '../beneath-walk.js';
import { modeAllows } from '../../vfs/posix-access.js';
import { openIdentified } from './filesystem.js';
import { WASI_RESIDENT_FILE_CAP_BYTES, DIRECTORY_BATCH_LIMIT, FS_READ_BATCH_PATH_LIMIT, FS_READ_BATCH_REQUEST_BYTES } from '../../constants.js';
import { RESIDENT_PAGE_BYTES } from '@nimbus-sh/platform/limits.js';
import { delegationHolder } from './delegation-holder.js';
import { readDirectoryPool } from './read-directory-pool.js';
/** Listings one call may take before it gives the question to the authority. */
const MAX_LISTINGS_PER_CALL = 64;
/** Directory opens a run records for the next run in its facet (ResidentFilesystem.walked). */
const WALKED_DIRECTORIES = 1024;
/**
 * Read-ahead of a directory's files, earned by its misses. A program that
 * reads a directory's files one after another (rolldown loading modules,
 * an interpreter importing) pays a round trip for each it does not hold:
 * Vite 8 pre-bundling lucide-react read 2,145 modules in 30.5 s, and in
 * 8.3 s with the same files fetched ahead (throwaway, 2026-10-07). From a
 * directory's second miss, a fill brings with it the directory's next files
 * of the missed file's extension (in descriptor order after it, then from
 * the directory's first), a window that doubles with each further miss there. A program that reads one file
 * of a directory fetches only that file. Bounded per file, per batch (one
 * fsReadBatch) and per process.
 */
const READ_AHEAD_FIRST = 8;
const READ_AHEAD_FILE_BYTES = 256 * 1024;
const READ_AHEAD_PROCESS_BYTES = 32 * 1024 * 1024;
/** A name's extension, with its dot ('.mjs'), or '' when it has none. */
function extensionOf(name) {
    const base = name.slice(name.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot) : '';
}
/** What this adapter answers itself is decided here: anything else is the authority's. */
const DELEGATE = Symbol('delegate');
/** The root of the namespace as the walk asks about it (the authority's rootStat, for what the walk reads). */
const ROOT_FOR_WALK = { type: 'directory', mode: 0o40755, uid: 0, gid: 0 };
/**
 * The session's calls that can change a name or an access: before one, the
 * files this process holds open write through (DelegationHolder.changing),
 * so their opens are decided as they were.
 */
const NAME_OR_ACCESS_CHANGES = new Set([
    'chmod', 'chown', 'fchmod', 'fchown', 'rename', 'unlink', 'rmdir', 'remove', 'copyFile', 'copyTree', 'writeBatch', 'writeStream',
]);
/** The calls that can change the namespace or bytes: after one, the barrier is owed. */
const MUTATIONS = new Set([
    'writeFile', 'writeFileFrom', 'writeRange', 'truncate', 'utimes', 'chmod', 'chown', 'write', 'close', 'mkdir',
    'unlink', 'rmdir', 'rename', 'symlink', 'remove', 'copyFile', 'copyTree', 'ftruncate', 'fchmod', 'fchown',
    'futimes', 'writeBatch', 'writeStream',
]);
const DESCRIPTOR_CALLS = new Set(['read', 'write', 'close', 'fstat', 'dup', 'seek', 'setStatus', 'readdirHandle', 'ftruncate', 'fchmod', 'fchown', 'futimes', 'fsync']);
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
    let directoryPool = null;
    const counts = { local: 0, delegated: {}, lookups: 0, listings: 0, treeListings: 0, fills: 0, filledBytes: 0, readAhead: 0, barriers: 0, waitMs: 0, pinnedBytes: 0, pins: 0, pagedReads: 0, pagesFetched: 0 };
    // Every wait on the session is timed where it leaves: the authority's calls
    // and the store's listings, fills and barriers. A facet's clock moves only
    // across I/O, so this is the part of a run's wall time the filesystem cost.
    const timed = (value) => {
        if (!(value instanceof Promise))
            return value;
        const started = Date.now();
        return value.finally(() => { counts.waitMs += Date.now() - started; directoryPool?.io(); });
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
            return (...args) => {
                if (typeof name === 'string' && DESCRIPTOR_CALLS.has(name) && typeof args[0] === 'number' && directoryPool?.closed(args[0])) {
                    throw fsError('EBADF', name, String(args[0]));
                }
                for (const arg of args) {
                    if (arg && typeof arg === 'object' && 'directory' in arg && 'path' in arg
                        && typeof arg.directory === 'number' && typeof arg.path === 'string' && directoryPool?.closed(arg.directory)) {
                        throw fsError('EBADF', String(name), String(arg.directory));
                    }
                }
                if (holder !== null && typeof name === 'string' && NAME_OR_ACCESS_CHANGES.has(name))
                    holder.changing();
                return holder !== null && holder.pending()
                    ? timed(holder.send().then(() => Reflect.apply(value, target, args)))
                    : timed(Reflect.apply(value, target, args));
            };
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
        content: (key, revision) => resident.content(key, revision),
        fill: (key, entry) => timed(resident.fill(key, entry)),
        pages: (key, revision, size, first, last) => timed(resident.pages(key, revision, size, first, last)),
        fillMany: (files) => timed(resident.fillMany(files)),
        barrier: () => timed(resident.barrier()),
        cursor: () => resident.cursor(),
        admit: (answer) => resident.admit(answer),
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
            sent: () => { owed = true; directoryPool?.invalidate(); },
        });
        if (delegation.readDirectories)
            directoryPool = readDirectoryPool({
                call: (request) => { delegated('readDirectories'); return timed(delegation.readDirectories(request)); }, store, client: holder.client,
                before: async () => { if (holder?.pending())
                    await holder.send(); },
            });
    }
    /** The session's descriptors this process opened read-only: closing one changes nothing, so it owes no barrier. */
    const readers = new Set();
    /** And those opened to write that nothing was written or cut through yet (git's /dev/null): no more do they. */
    const unwritten = new Set();
    /** Of the read-only ones, the directories, and where their listing is. */
    const directories = new Map();
    /**
     * The session's read-only descriptors of files too big to hold whole (a
     * pack, a deep history's .idx), by the name and file (dev, ino) each
     * opened: a positional read of one is answered from the store's pages of
     * that file at the revision the name says it has, read a batch at a time
     * and kept for the next reader. Once the name leads elsewhere, or a read
     * cannot be answered, the descriptor reads through the session.
     */
    const paged = new Map();
    /** Bytes pinned for the codec's own descriptors (pinContent). */
    const pins = new Map();
    /** A write-through description's reader: the session's read-only descriptor of its file, opened at its first read. */
    const throughReaders = new Map();
    /**
     * One walk over what the store knows: the resolved key, ELOOP (null), a
     * directory to list first, or DELEGATE when the walk reaches what this
     * adapter does not answer. The authority's refusals are thrown as its own.
     * `crossed`: every name it looked up, in order.
     */
    const walkOnce = (root, name, follow, crossed) => {
        const walk = walkBeneath(root, { root, path: name, beneath: true }, follow, store.cred, () => false);
        if (crossed !== undefined)
            crossed.length = 0;
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
            crossed?.push(key);
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
        if (directoryPool?.owns(handleId))
            return directoryPool.local(handleId)?.key;
        const open = directories.get(handleId);
        if (open === undefined)
            return undefined;
        const entry = store.entry(open.key);
        return entry && entry.type === 'directory' && entry.dev === open.dev && entry.ino === open.ino ? open.key : undefined;
    };
    /**
     * The directories a walk opens next, after `key`: preorder, names in the
     * order a descriptor lists them (byCodeUnit), on past `key`'s subtree to
     * the rest of the walk beneath `within`, as listed so far.
     */
    const walkAfter = (key, within, limit) => {
        const out = [];
        const subdirectories = (dir) => byCodeUnit((store.children(dir) ?? []).filter((child) => child.type === 'directory'))
            .map((child) => (dir === '' ? child.name : `${dir}/${child.name}`));
        const descend = (dir) => {
            for (const child of subdirectories(dir)) {
                if (out.length >= limit)
                    return;
                out.push(child);
                descend(child);
            }
        };
        descend(key);
        for (let at = key; at !== within && out.length < limit; at = parentKey(at)) {
            const name = at.slice(at.lastIndexOf('/') + 1);
            for (const sibling of subdirectories(parentKey(at))) {
                if (out.length >= limit)
                    break;
                if (sibling.slice(sibling.lastIndexOf('/') + 1) <= name)
                    continue;
                out.push(sibling);
                descend(sibling);
            }
        }
        return out;
    };
    /** Where the walk the last directory open belongs to began: `walkAfter`'s bound. */
    let walkRoot = null;
    /** The directories opened so far, in order; and the last run's, as its walk goes on. */
    const opening = [];
    const previous = delegation?.walked ?? [];
    let along = 0;
    /**
     * The directories the last run opened after `key`, from where this run has
     * got to in its walk: what it opens next, if it repeats it.
     */
    const repeated = (key, limit) => {
        const at = previous.indexOf(key, along);
        if (at < 0)
            return [];
        along = at + 1;
        return previous.slice(at + 1, at + 1 + limit);
    };
    /**
     * Misses by directory: names the store did not know there, and bytes it
     * did not hold. From a directory's second, it is listed in one answer: its
     * subtree when names missed there were found (a walk; unless past the
     * listing's bound), else itself (a probe for names that are not there);
     * and its files are fetched ahead (READ_AHEAD_*).
     */
    const missesIn = new Map();
    const miss = (dir) => {
        const misses = (missesIn.get(dir) ?? 0) + 1;
        missesIn.set(dir, misses);
        return misses;
    };
    const unlistable = new Set();
    /** Whether the name a directory's last miss looked up was there: its misses are a walk of what is there, not a probe. */
    const foundIn = new Map();
    /** Files a read-ahead batch is fetching, and the batch; and the bytes read ahead so far. */
    const fetchingAhead = new Map();
    let readAheadBytes = 0;
    /**
     * A fill of `key` (`entry`), with the files of its directory read ahead
     * when its misses earned it: the batch, which includes `key`, or undefined
     * when `key` is filled alone.
     */
    const readAhead = (key, entry) => {
        const dir = parentKey(key);
        const misses = miss(dir);
        const ext = extensionOf(key);
        const children = store.children(dir);
        if (misses < 2 || ext === '' || children === undefined)
            return undefined;
        const window = READ_AHEAD_FIRST * 2 ** Math.min(misses - 2, 7);
        const name = key.slice(key.lastIndexOf('/') + 1);
        const batch = [[key, entry]];
        let bytes = entry.size;
        const ordered = byCodeUnit(children.filter((child) => child.type === 'file' && child.name !== name && extensionOf(child.name) === ext));
        const at = ordered.findIndex((child) => child.name > name);
        for (const child of at < 0 ? ordered : [...ordered.slice(at), ...ordered.slice(0, at)]) {
            if (batch.length > window || batch.length >= FS_READ_BATCH_PATH_LIMIT)
                break;
            const sibling = dir === '' ? child.name : `${dir}/${child.name}`;
            if (fetchingAhead.has(sibling))
                continue;
            const found = entryAt(sibling);
            if (!found || found.type !== 'file' || found.size > READ_AHEAD_FILE_BYTES || store.content(sibling, found.revision) !== undefined)
                continue;
            // What this process decided or writes through is its own to read.
            if (holder?.content(found) !== undefined || holder?.writing(found.ino) !== undefined)
                continue;
            if (bytes + found.size > FS_READ_BATCH_REQUEST_BYTES || readAheadBytes + bytes + found.size > READ_AHEAD_PROCESS_BYTES)
                break;
            batch.push([sibling, found]);
            bytes += found.size;
        }
        if (batch.length === 1)
            return undefined;
        readAheadBytes += bytes - entry.size;
        counts.fills += batch.length;
        counts.filledBytes += bytes;
        counts.readAhead += batch.length - 1;
        const fetched = store.fillMany(batch).catch(() => { });
        for (const [path] of batch)
            fetchingAhead.set(path, fetched);
        void fetched.then(() => { for (const [path] of batch)
            if (fetchingAhead.get(path) === fetched)
                fetchingAhead.delete(path); });
        return fetched;
    };
    /** Where a path leads (its key), listing what the walk needs; DELEGATE for what this adapter does not answer. `crossed`: the names the walk that placed it looked up. */
    const resolve = (path, follow, content = false, crossed) => {
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
        // listed (which also says what is absent in it). A directory asked about
        // a second time is being walked: its subtree is listed in one answer,
        // unless it is past the listing's bound.
        const looked = new Set();
        const attempt = (asked) => {
            const walked = walkOnce(root, name, follow, crossed);
            if (walked === null || walked === DELEGATE || typeof walked === 'string')
                return walked;
            if (asked >= MAX_LISTINGS_PER_CALL)
                return DELEGATE;
            const parent = parentKey(walked.missing);
            if (miss(parent) >= 2 && parent !== '' && store.children(parent) === undefined) {
                // A walk of what is there (the name its last miss looked up was
                // found): the subtree in one answer; past its bound, the directory
                // alone. A probe for what is not (an interpreter's import path): the
                // directory alone.
                const walking = foundIn.get(parent) === true && !unlistable.has(parent);
                const whole = walking ? (counts.treeListings++, store.listTree(parent)) : Promise.resolve(false);
                return whole
                    .then((listed) => {
                    if (listed)
                        return true;
                    if (walking)
                        unlistable.add(parent);
                    counts.listings++;
                    return store.list(parent);
                })
                    .then((listed) => (listed ? attempt(asked + 1) : DELEGATE));
            }
            if (!looked.has(walked.missing)) {
                const spelled = prefixes(root, name).filter((key) => !looked.has(key) && store.entry(key) === undefined);
                const keys = spelled.includes(walked.missing) ? spelled.slice(spelled.indexOf(walked.missing)) : [walked.missing];
                for (const key of keys)
                    looked.add(key);
                counts.lookups++;
                // The bytes of what the call names, when it is a small file: a stat is followed by an open.
                const target = spelled[spelled.length - 1];
                return store.lookup(keys, content && keys[keys.length - 1] === target)
                    .then((known) => {
                    if (known)
                        foundIn.set(parent, Boolean(store.entry(walked.missing)));
                    return known ? attempt(asked + 1) : DELEGATE;
                });
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
        const held = store.content(key, entry.revision);
        if (held !== undefined && held.byteLength === entry.size)
            return held;
        const fill = () => {
            counts.fills++;
            counts.filledBytes += entry.size;
            return store.fill(key, entry).then(keep);
        };
        // A batch fetching it (read-ahead) is waited on, not repeated.
        const batch = fetchingAhead.get(key) ?? readAhead(key, entry);
        if (batch === undefined)
            return fill();
        return batch.then(() => {
            const fetched = store.content(key, entry.revision);
            return fetched !== undefined && fetched.byteLength === entry.size ? fetched : fill();
        });
    };
    /**
     * Answer from the store when it can, else from the authority: the barrier
     * first when one is owed, then `local`, whose DELEGATE hands the call on.
     */
    const answer = (name, local, remote) => {
        // What this process wrote through is the session's before the store
        // answers for it: sent first (and the barrier owed), so it reads its own writes.
        if (holder !== null && holder.throughPending())
            return holder.send().then(() => answer(name, local, remote));
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
    /** `path`'s walk for a mutation (the key it resolves to, and every name crossed to it), or DELEGATE. */
    const walkFor = (path, follow) => {
        const crossed = [];
        return after(resolve(path, follow, false, crossed), (key) => (typeof key === 'string' && key !== '' ? { key, crossed } : DELEGATE));
    };
    /**
     * Whether the holder may be asked to decide a change at `key` on its
     * walks. Where it holds `key`'s subtree, only when every name they crossed
     * is guarded (ProcessFsClient.guards), so none changes before the process
     * answers and the key stays what the caller's spelling denotes; else the
     * session resolves the call. Where it does not, the holder declines it
     * anyway, counting it toward taking the subtree.
     */
    const decidable = (key, ...walks) => holder.client.held(key) === undefined
        || walks.every((walk) => walk.crossed.every((name) => holder.client.guards(name)));
    /** The authority, for a call that may change what the store holds: the barrier is owed once it returns. */
    const changing = (name, call) => {
        directoryPool?.invalidate();
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
    fs.inbound = () => { owed = true; directoryPool?.invalidate(); };
    fs.cancelPendingDirectories = () => { owed = true; directoryPool?.cancelPending(); };
    fs.holding = () => holder?.pending() ?? false;
    fs.logHeld = () => holder?.logHeld();
    // What leaves the process is preceded by everything it logged.
    fs.flush = async () => { await holder?.flush(); };
    fs.settle = async () => {
        const failures = [];
        // The run's end, both at once: the directory descriptions it holds are
        // retired, what it logged is answered, and what it held is given back.
        await Promise.all([directoryPool?.dispose(), holder?.settle()].map((ending) => Promise.resolve(ending).catch((error) => {
            failures.push({ path: '/', dev: 0, ino: 0, error });
        })));
        return failures;
    };
    // A sync of a file through any descriptor: everything this process logged
    // is answered first, and a refusal it recorded is this sync's answer.
    fs.syncInode = () => holder?.flush();
    fs.walked = () => opening;
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
                name: '/' + key,
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
    /** A descriptor of the holder's, as an open answers it: with its stat, the holder's. */
    const heldOpen = (handle) => ({ ...handle, stat: statOf(holder.fstat(handle.id)) });
    fs.access = (path, mode) => answer('access', () => after(resolve(path, true), (key) => {
        if (key === DELEGATE || key === '')
            return DELEGATE;
        if (key === null)
            throw fsError('ELOOP', 'access', path);
        const entry = entryAt(key);
        if (entry === undefined)
            return DELEGATE;
        if (entry === null)
            throw fsError('ENOENT', 'access', path);
        if (!modeAllows(entry, mode, store.cred))
            throw fsError('EACCES', 'access', path);
        return undefined;
    }), () => authority.access(path, mode));
    fs.open = (path, flags) => {
        const readOnly = !flags.write && !flags.create && !flags.truncate && !flags.append && !flags.exclusive;
        if (directoryPool && readOnly && flags.read === true && flags.directory === true && flags.followSymlinks !== false && flags.expectedRevision === undefined) {
            return answer('open', () => after(resolve(path, true), async (key) => {
                if (key === DELEGATE || key === null || key === '' || entryAt(key)?.type !== 'directory')
                    return DELEGATE;
                if (walkRoot === null || (key !== walkRoot && !key.startsWith(walkRoot + '/')))
                    walkRoot = key;
                const within = walkRoot;
                // A walk is earned: the run's first directory open (an interpreter
                // listing its working directory) opens that one alone, unless the
                // last run in this facet walked from it.
                const walking = opening.length > 0;
                if (opening.length < WALKED_DIRECTORIES)
                    opening.push(key);
                const handle = await directoryPool.open(path, key, async () => {
                    const guessed = repeated(key, DIRECTORY_BATCH_LIMIT - 1);
                    if (!walking && guessed.length === 0)
                        return [];
                    // The existing bounded namespace listing owns these names. Walk
                    // only directories it actually reported; no invented path/prefix.
                    await listingOf(key);
                    // What the last run opened next comes first; then the walk on from here.
                    const next = [...new Set([...guessed, ...walkAfter(key, within, DIRECTORY_BATCH_LIMIT - 1)])];
                    // Carry the caller's confinement/descriptor root to the authority;
                    // never replace a beneath lookup with an absolute one. A
                    // descriptor-relative open names only what is beneath its directory.
                    const beneath = (base) => next.filter((candidate) => base === '' || candidate.startsWith(base + '/'));
                    if (typeof path === 'string')
                        return next.slice(0, DIRECTORY_BATCH_LIMIT - 1).map((candidate) => '/' + candidate);
                    if ('directory' in path) {
                        const base = path.path.replace(/\/$/, '');
                        return beneath(key).slice(0, DIRECTORY_BATCH_LIMIT - 1)
                            .map((candidate) => ({ ...path, path: (base === '' ? '' : base + '/') + candidate.slice(key.length + 1) }));
                    }
                    const root = keyOf(path.root);
                    return beneath(root).slice(0, DIRECTORY_BATCH_LIMIT - 1)
                        .map((candidate) => ({ ...path, path: root === '' ? candidate : candidate.slice(root.length + 1) }));
                });
                if (handle === null)
                    return DELEGATE;
                // An open answers its stat (RuntimeOpenedFile): the one a prefetched directory's fstat answers here.
                return { ...handle, stat: await fs.fstat(handle.id) };
            }), () => openOnSession(path, flags));
        }
        if (!readOnly && holder !== null) {
            // A file made or emptied in a subtree this process holds is decided here.
            const local = decide('open', () => after(walkFor(path, true), (walk) => (walk === DELEGATE || !decidable(walk.key, walk) ? DELEGATE
                : after(holder.open(walk.key, typeof path === 'string' ? path : path.path, flags), (handle) => (handle === undefined ? DELEGATE : heldOpen(handle))))));
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
                return after(walkFor(path, false), (walk) => {
                    if (walk === DELEGATE)
                        return DELEGATE;
                    const there = entryAt(walk.key);
                    if (there === undefined || there?.type === 'directory')
                        return DELEGATE;
                    delegated('open');
                    return after(holder.openThrough(walk.key, typeof path === 'string' ? path : path.path, flags), (handle) => { owed = true; return heldOpen(handle); });
                });
            };
            return after(through(), (handle) => {
                if (handle !== DELEGATE)
                    return handle;
                if (flags.create || flags.truncate)
                    return changing('open', () => authority.open(path, flags));
                // An open that makes and empties nothing changes nothing: its writes will, each a call of its own.
                delegated('open');
                return after(authority.open(path, flags), (opened) => { unwritten.add(opened.id); return opened; });
            });
        }
        // A read-only open is the session's descriptor (it has what this process logged first).
        delegated('open');
        return after(authority.open(path, flags), (handle) => {
            readers.add(handle.id);
            // What it is, its open said: a directory is listed here, and a file too big to hold whole is paged, while its name still leads to it.
            const { type, dev, ino, size } = handle.stat;
            if (dev === store.device) {
                const key = keyOf(handle.path);
                if (type === 'directory')
                    directories.set(handle.id, { key, dev, ino });
                else if (type === 'file' && size > WASI_RESIDENT_FILE_CAP_BYTES)
                    paged.set(handle.id, { key, dev, ino });
            }
            return handle;
        });
    };
    fs.fstat = (handleId) => {
        if (directoryPool?.owns(handleId))
            return answer('fstat', () => {
                const current = directoryPool.local(handleId);
                return current ? statOf(current.entry) : DELEGATE;
            }, () => authority.fstat(handleId));
        if (holder?.owns(handleId)) {
            // Written through: the session's live stat of its file, once what it
            // wrote is there; a name that no longer leads to its file is gone (nlink 0).
            if (holder.through(handleId))
                return liveThrough(handleId);
            counts.local++;
            return statOf(holder.fstat(handleId));
        }
        delegated('fstat');
        return authority.fstat(handleId);
    };
    /**
     * A write-through description's stat: the session's, of its description's
     * own file (renamed, unlinked or replaced, it is still that file), once
     * what the process logged before it is answered. A mount's file keeps no
     * description: its stat is its name's.
     */
    const liveThrough = async (handleId) => {
        await holder.send();
        const session = await holder.sessionOf(handleId);
        if (session !== undefined) {
            delegated('fstat');
            return authority.fstat(session);
        }
        delegated('stat');
        const own = holder.fstat(handleId);
        const live = await authority.stat('/' + holder.keyOf(handleId), { followSymlinks: false });
        return live !== null && live.ino === own.ino ? live : statOf({ ...own, nlink: 0 });
    };
    /**
     * The session's bytes for write-through description `handleId`: through
     * its description's own descriptor (its file, wherever it is named, with
     * the access it was opened with). A mount's file, which keeps none, is
     * read by a read-only descriptor of its name.
     */
    const readThrough = (handleId) => async (key, at, length) => {
        let reader = await holder.sessionOf(handleId) ?? throughReaders.get(handleId);
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
        const file = paged.get(handleId);
        // Positional reads only: a read at the descriptor's offset is the descriptor's to advance.
        if (file !== undefined && offset !== null && length > 0) {
            return answer('read', () => after(resolve('/' + file.key, false), (resolved) => {
                // The file as this process has learned of it (a barrier forgets a
                // name it changed, and the walk learns it again). Once the name leads
                // to another file, the pages are not this descriptor's bytes.
                const now = resolved === DELEGATE ? undefined : entryAt(file.key);
                if (now === undefined || now === null || now.type !== 'file' || now.dev !== file.dev || now.ino !== file.ino) {
                    paged.delete(handleId);
                    return DELEGATE;
                }
                if (offset >= now.size)
                    return new Uint8Array(0);
                const end = Math.min(now.size, offset + length);
                const first = Math.floor(offset / RESIDENT_PAGE_BYTES);
                const last = Math.floor((end - 1) / RESIDENT_PAGE_BYTES);
                return after(store.pages(file.key, now.revision, now.size, first, last), (found) => {
                    if (found === null) {
                        paged.delete(handleId);
                        return DELEGATE;
                    }
                    counts.pagedReads++;
                    counts.pagesFetched += found.fetched;
                    const out = new Uint8Array(end - offset);
                    found.pages.forEach((page, i) => {
                        const start = (first + i) * RESIDENT_PAGE_BYTES;
                        const from = Math.max(offset, start);
                        const to = Math.min(end, start + page.byteLength);
                        out.set(page.subarray(from - start, to - start), from - offset);
                    });
                    return out;
                });
            }), () => authority.read(handleId, offset, length));
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
        unwritten.delete(handleId);
        return changing('write', () => authority.write(handleId, offset, bytes));
    };
    fs.ftruncate = (handleId, size) => {
        if (holder?.owns(handleId)) {
            counts.local++;
            holder.ftruncate(handleId, size);
            return;
        }
        unwritten.delete(handleId);
        return changing('ftruncate', () => authority.ftruncate(handleId, size));
    };
    fs.close = (handleId) => {
        if (directoryPool?.owns(handleId)) {
            counts.local++;
            return directoryPool.close(handleId);
        }
        // A descriptor of the holder's closes here: what it wrote is in the log.
        if (holder?.owns(handleId)) {
            counts.local++;
            holder.close(handleId);
            // A refusal already recorded is the close's to report, as a write-back
            // error is; nothing is waited for, and the descriptor is closed anyway.
            const report = () => holder.reportRecorded();
            const reader = throughReaders.get(handleId);
            if (reader === undefined)
                return report();
            throughReaders.delete(handleId);
            delegated('close');
            return after(authority.close(reader), report);
        }
        if (readers.delete(handleId)) {
            directories.delete(handleId);
            paged.delete(handleId);
            delegated('close');
            return authority.close(handleId);
        }
        if (unwritten.delete(handleId)) {
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
    // O_APPEND of one of the holder's descriptors is its writes' to keep (an append call or a write call).
    const bySessionStatus = Reflect.get(fs, 'setStatus');
    if (typeof bySessionStatus === 'function') {
        Reflect.set(fs, 'setStatus', (handleId, status) => {
            if (holder?.owns(handleId)) {
                counts.local++;
                holder.setStatus(handleId, status);
                return;
            }
            return Reflect.apply(bySessionStatus, fs, [handleId, status]);
        });
    }
    // A descriptor of the holder's is reopened here where the holder decides it,
    // else once what was decided is sent: a description written through by its
    // session descriptor, any other by its file's name while that name has it.
    const bySessionReopen = Reflect.get(fs, 'reopen');
    if (typeof bySessionReopen === 'function') {
        Reflect.set(fs, 'reopen', (target, flags, options) => {
            const held = holder;
            if (!held?.owns(target.handle))
                return Reflect.apply(bySessionReopen, fs, [target, flags, options]);
            const local = held.reopen(target.handle, flags);
            if (local !== undefined) {
                counts.local++;
                return heldOpen(local);
            }
            const identity = held.fstat(target.handle);
            const name = '/' + held.keyOf(target.handle);
            return held.flush().then(() => held.sessionOf(target.handle)).then((session) => (session === undefined
                ? openIdentified(fs, name, false, flags, identity)
                : Reflect.apply(bySessionReopen, fs, [{ handle: session }, flags, options])));
        });
    }
    for (const name of ['fchmod', 'fchown', 'futimes', 'dup']) {
        const passed = Reflect.get(fs, name);
        if (typeof passed !== 'function')
            continue;
        Reflect.set(fs, name, (handleId, ...rest) => {
            if (!holder?.owns(handleId))
                return Reflect.apply(passed, fs, [handleId, ...rest]);
            if (name === 'dup')
                return holder.dup(handleId);
            return holderAttrs(name, passed, handleId, rest);
        });
    }
    /** An fchown side as the guest sent it: a uid or gid, or null (keep the file's). */
    const ownerSide = (value) => typeof value === 'number' ? value : null;
    /**
     * fchmod, fchown and futimes of a descriptor of the holder's, on the file
     * it opened, never on a name: decided here where the holder decides that
     * file, else through the description the session holds of it (the file
     * written through first), and its stat as the session then says.
     */
    const holderAttrs = (name, passed, handleId, rest) => {
        const change = name === 'fchmod' ? { mode: Number(rest[0]) }
            : name === 'fchown' ? { uid: ownerSide(rest[0]), gid: ownerSide(rest[1]) }
                : { atime: rest[0], mtime: rest[1] };
        if (holder.fsetattr(handleId, change))
            return undefined;
        holder.changing([holder.keyOf(handleId)]);
        return holder.flush().then(() => holder.sessionOf(handleId)).then(async (session) => {
            if (session === undefined)
                throw fsError('EBADF', name, '/' + holder.keyOf(handleId));
            await passed.call(fs, session, ...rest);
            holder.restat(handleId, await fs.fstat(session));
        });
    };
    /**
     * A change by name no held subtree decides: an op of the process's client
     * when the store places the name (ordered with everything it logged,
     * answered before the call returns), else the session's call (its proxy
     * sends what the process logged first).
     */
    const byClient = (name, op) => {
        delegated(name);
        // A name it changes: the files the process holds open at or under it write through first.
        if (op.type === 'rename')
            holder.changing([op.from, op.to]);
        else if (op.type === 'call' && (op.call.call === 'unlink' || op.call.call === 'rmdir'))
            holder.changing([op.call.path]);
        return holder.client.submit(op).then(() => { owed = true; }, (error) => { owed = true; throw error; });
    };
    const pathOf = (path) => (typeof path === 'string' ? path : path.path);
    /** Where the store places `path` (its directory resolved, the name itself not followed), current first; DELEGATE when it cannot say. */
    const placedWalk = (path) => {
        if (holder === null || !store.ready())
            return DELEGATE;
        if (!owed)
            return walkFor(path, false);
        counts.barriers++;
        return store.barrier().then((ok) => {
            if (!ok || !store.ready())
                return DELEGATE;
            owed = false;
            return walkFor(path, false);
        });
    };
    // Changes by name a held subtree holds are decided here; any other is the session's, through the client.
    const bySessionMkdir = fs.mkdir;
    fs.mkdir = (path, options) => {
        if (holder === null || options?.recursive)
            return bySessionMkdir(path, options);
        const mode = options?.mode ?? 0o777;
        let named;
        const local = decide('mkdir', () => after(walkFor(path, false), (walk) => {
            if (walk === DELEGATE)
                return DELEGATE;
            named = walk.key;
            if (!decidable(walk.key, walk))
                return DELEGATE;
            return after(holder.mkdir(walk.key, pathOf(path), mode, options?.umask), (done) => (done ? undefined : DELEGATE));
        }));
        return after(local, (done) => (done !== DELEGATE ? undefined
            : named !== undefined ? byClient('mkdir', { type: 'call', call: { call: 'mkdir', path: named, mode, ...(options?.umask === undefined ? {} : { umask: options.umask }) } }) : bySessionMkdir(path, options)));
    };
    const bySessionUnlink = fs.unlink;
    fs.unlink = (path) => {
        if (holder === null)
            return bySessionUnlink(path);
        let named;
        const local = decide('unlink', () => after(walkFor(path, false), (walk) => {
            if (walk === DELEGATE)
                return DELEGATE;
            named = walk.key;
            if (!decidable(walk.key, walk))
                return DELEGATE;
            return after(holder.unlink(walk.key, pathOf(path)), (done) => (done ? undefined : DELEGATE));
        }));
        return after(local, (done) => (done !== DELEGATE ? undefined
            : named !== undefined ? byClient('unlink', { type: 'call', call: { call: 'unlink', path: named } }) : bySessionUnlink(path)));
    };
    /**
     * The store's bytes of the file `walk` reaches, where this view is the
     * session's for all they depend on, as a held stat's is
     * (ProcessFsClient.vouch at the view's cursor): every name the walk
     * crossed vouched for, the file itself held. Undefined where the view
     * cannot vouch for them.
     */
    const vouchedContent = ({ key, crossed }) => {
        const cursor = store.cursor();
        if (cursor === null || holder.client.vouch(key, cursor) !== 'held')
            return undefined;
        if (!crossed.every((name) => holder.client.vouch(name, cursor) !== undefined))
            return undefined;
        const entry = entryAt(key);
        return entry ? store.content(key, entry.revision) : undefined;
    };
    // A copy both of whose names a held subtree holds, its source's bytes the
    // holder's or ones the view vouches for: decided here; any other, the
    // session's.
    const bySessionCopy = fs.copyFile;
    fs.copyFile = (from, to, options) => {
        if (holder === null)
            return bySessionCopy(from, to, options);
        const local = decide('copyFile', () => after(walkFor(from, true), (source) => (source === DELEGATE ? DELEGATE
            : after(walkFor(to, true), (target) => {
                if (target === DELEGATE || !decidable(target.key, source, target))
                    return DELEGATE;
                return holder.copyFile(source.key, target.key, pathOf(to), vouchedContent(source), options?.keepMode === true) ? undefined : DELEGATE;
            }))));
        return after(local, (done) => (done !== DELEGATE ? undefined : bySessionCopy(from, to, options)));
    };
    const bySessionRename = fs.rename;
    fs.rename = (from, to) => {
        if (holder === null)
            return bySessionRename(from, to);
        let names;
        const local = decide('rename', () => after(walkFor(from, false), (source) => (source === DELEGATE ? DELEGATE
            : after(walkFor(to, false), (target) => {
                if (target === DELEGATE)
                    return DELEGATE;
                names = [source.key, target.key];
                if (!decidable(source.key, source, target))
                    return DELEGATE;
                return after(holder.rename(source.key, target.key, pathOf(from)), (done) => (done ? undefined : DELEGATE));
            }))));
        return after(local, (done) => (done !== DELEGATE ? undefined
            : names !== undefined ? byClient('rename', { type: 'rename', from: names[0], to: names[1] }) : bySessionRename(from, to)));
    };
    // An attribute change by name: decided here where a held subtree holds the
    // name (counted toward taking it either way), else the session's, after
    // what the holder has; one it holds but did not decide (another's file, a
    // grant the session judges) is the session's in its view after. Not a
    // link's own (lchown, lutimes), nor times now: the session's alone.
    for (const name of ['chmod', 'chown', 'utimes']) {
        const passed = Reflect.get(fs, name);
        Reflect.set(fs, name, (path, ...rest) => {
            const options = rest[2];
            const attrs = name === 'chmod' ? { mode: Number(rest[0]) }
                : options?.followSymlinks === false ? null
                    : name === 'chown' ? { uid: ownerSide(rest[0]), gid: ownerSide(rest[1]) }
                        : typeof rest[0] === 'number' && typeof rest[1] === 'number' ? { atime: rest[0], mtime: rest[1] } : null;
            if (holder === null || attrs === null)
                return passed.call(fs, path, ...rest);
            let named;
            const local = decide(name, () => after(walkFor(path, true), (walk) => {
                if (walk === DELEGATE)
                    return DELEGATE;
                named = walk.key;
                if (!decidable(walk.key, walk))
                    return DELEGATE;
                return holder.setattr(walk.key, attrs) ? undefined : DELEGATE;
            }));
            return after(local, (done) => {
                if (done !== DELEGATE)
                    return undefined;
                const key = named;
                if (key === undefined || !holder.holds(key))
                    return passed.call(fs, path, ...rest);
                return after(passed.call(fs, path, ...rest), (receipt) => { holder.undecided(key); return receipt; });
            });
        });
    }
    // Nothing of these is decided here: by the client when the store places the name.
    const byName = (name, passed, pathAt, op) => (...args) => {
        if (holder === null)
            return passed(...args);
        const placed = placedWalk(args[pathAt]);
        return after(placed, (walk) => (walk === DELEGATE ? passed(...args) : byClient(name, op(walk.key, args))));
    };
    const bySessionRmdir = fs.rmdir;
    fs.rmdir = byName('rmdir', (path) => bySessionRmdir(path), 0, (key) => ({ type: 'call', call: { call: 'rmdir', path: key } }));
    const bySessionSymlink = fs.symlink;
    fs.symlink = byName('symlink', (target, path) => bySessionSymlink(target, path), 1, (key, [target]) => ({ type: 'call', call: { call: 'symlink', path: key, target } }));
    return fs;
}
