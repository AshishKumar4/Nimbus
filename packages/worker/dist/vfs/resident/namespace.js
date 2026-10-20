/**
 * The namespace: every name the credential can see, exact at the store's
 * cursor: filled from a complete listing, then moved forward by each ACQUIRE
 * delta, whose entries carry the path's stat at the answer's revision (null
 * when it is gone). A change of presence or stat is always a logged mutation
 * of that path, except what vanishes beneath a removed or replaced directory,
 * which the delta application drops by subtree. So a synchronous stat, exists
 * or readdir is answered exactly, and an absent name is known to be absent.
 *
 * This table holds the AUTHORITY's view only. The process's own pending
 * structural effects are an overlay kept by the shims, retired once a barrier
 * begun after they settled has applied.
 *
 * A node process lists every name before its program runs, because a
 * synchronous stat cannot wait for a listing. A process whose calls CAN wait
 * (a WASI guest, parked under JSPI) does not have to pay for names it never
 * looks at, and the bill is real: with a vscode clone in the session (24,683
 * names) the whole enumeration took `node -e 'console.log(1)'` from 0.40 s to
 * 2.0 s (throwaway, 2026-10-05). So such a process starts with no names and a
 * cursor, and lists a directory the first time a lookup needs one of its
 * entries (LAZY). A directory whose entries are all rows is LISTED; below one
 * that is not, a missing row means "not known", never "absent".
 *
 * Rows are what a listing or a delta put there, dated by their own revision,
 * exactly as for an enumerated namespace: deltas from the store's cursor
 * (taken before any listing) name everything that moved since, so a row is
 * never older than the cursor it is judged against.
 */
import { namespaceRowBytes } from './cell-cost.js';
import { namespaceAllows } from './permissions.js';
import { NS_DIR, NS_FILE, NS_LINK } from './tables.js';
import { arrayCopy, dateNow, Error, NumberOf, numberIsInteger, objectAssign, objectHasOwn, ownField, SafeList, SafeMap, SafeSet, StringFromCharCode, stringCharCodeAt, stringLastIndexOf, stringOf, stringSlice, stringStartsWith, } from '@nimbus-sh/core/_shared/primordials.js';
import { nsKey, nsName, nsParent, nsRowAt, walkNamespace } from './namespace-lookup.js';
export { nsKey, nsRowAt, nsSplit } from './namespace-lookup.js';
export function nsKindCode(type) {
    return type === 'directory' ? NS_DIR : type === 'symlink' ? NS_LINK : NS_FILE;
}
/** A record's own data field, retaining the type its contract gives it. */
function ownValue(record, key) {
    return objectHasOwn(record, key) ? record[key] : undefined;
}
/**
 * Whether a stat from the authority describes its name: a type, and the
 * mode, owner and group every permission check reads. One without them is
 * no record. Stored, its missing fields would become zeros, a root-owned
 * mode-0 file the authority never reported. The namespace then stops
 * answering (as for a delta without stats) until a listing that does
 * describe every name restores it.
 */
export function nsDescribes(stat) {
    if (stat === null || (typeof stat !== 'object' && typeof stat !== 'function') || typeof ownField(stat, 'type') !== 'string')
        return false;
    const mode = ownField(stat, 'mode');
    const uid = ownField(stat, 'uid');
    const gid = ownField(stat, 'gid');
    return mode !== null && mode !== undefined && numberIsInteger(NumberOf(mode))
        && uid !== null && uid !== undefined && numberIsInteger(NumberOf(uid))
        && gid !== null && gid !== undefined && numberIsInteger(NumberOf(gid));
}
/**
 * The exclusive upper bound of a prefix under the BINARY collation SQLite gives
 * a TEXT PRIMARY KEY — the successor of the last code unit it can increment.
 * Null when there is none (an empty prefix, or one ending in U+FFFF), and the
 * caller then scans open-ended, which is correct and merely slower.
 *
 * Every caller passes a directory prefix ending in '/', so the increment is
 * '/' → '0' and UTF-16 and UTF-8 orderings agree exactly. They diverge only
 * around the surrogate range, which no path segment separator lives in.
 */
export function prefixEnd(prefix) {
    for (let i = prefix.length - 1; i >= 0; i--) {
        const code = stringCharCodeAt(prefix, i);
        if (code < 0xffff)
            return stringSlice(prefix, 0, i) + StringFromCharCode(code + 1);
    }
    return null;
}
export function createNamespace(coherence, admission) {
    // The clock, taken as the store is made, before a run that can stop tapes
    // Date (stop-replay.ts): an own file's time is stamped when its write is
    // answered, which a run and its run again do at other moments.
    const realNow = dateNow;
    /** Paths of every symlink in the table: resolution walks only past these. */
    let links = new SafeSet();
    /** Told of each row put (onPut). */
    let putListener = null;
    /**
     * Directories on a mount whose entries the listing did not name (the launch
     * did not name them, or they were past its bound), each to the mount point
     * it is on. A name at or under one is not known absent, only not listed.
     * Held in the row's `target`, which a directory has no other use for.
     */
    let unlisted = new SafeMap();
    /** The credential names are judged traversable for. */
    let cred = null;
    /** The persisted 'ns' flag, mirrored in heap because every stat asks it. */
    let ok = false;
    /** Why the namespace stopped answering, while it does not: what a refused sync call names. */
    let cause = 'the process has not listed it yet';
    /** Whether this store lists on demand (beginLazy) rather than enumerating. */
    let lazy = false;
    /** Directories (keys) every entry of which is a row: below them a missing row is an absent name. */
    const listed = new SafeSet();
    /** Moved whenever the table is replaced or stops answering: a learning asked before installs nothing. */
    let generation = 0;
    /** Each learning in flight, with every path an admitted delta named since it was asked. */
    const learnings = new SafeSet();
    const ready = () => ok && coherence.serving();
    /** Directories whose relists are on their way, with how many (fence): nothing at or under one is answered. */
    let relisting = new SafeMap();
    const fenced = (k) => {
        if (relisting.size === 0)
            return false;
        let hit = false;
        relisting.forEach((_count, dir) => { if (!hit && (dir === '' || k === dir || stringStartsWith(k, dir + '/')))
            hit = true; });
        return hit;
    };
    /**
     * Whether every entry of directory `dir` is a row, so a missing row below
     * it is an absent name. Listed on demand: once a completed listing named
     * them. Enumerated: a directory the table holds that carries no mark (a
     * mount left it unlisted, or a lookup learned it without its entries) and
     * no relist is on its way to; the top once the namespace is answering.
     */
    const isListed = (dir) => {
        if (lazy)
            return listed.has(dir);
        if (!ready() || fenced(dir) || unlisted.get(dir) !== undefined)
            return false;
        if (dir === '')
            return true;
        const row = nsRowAt(coherence.require(), dir);
        return row !== undefined && row.kind === NS_DIR;
    };
    const markListed = (dir) => {
        if (lazy) {
            listed.add(dir);
            return;
        }
        if (dir === '' || unlisted.get(dir) === undefined)
            return;
        const t = coherence.require();
        const row = nsRowAt(t, dir);
        if (row === undefined || row.kind !== NS_DIR)
            return;
        t.nsPut(nsParent(dir), nsName(dir), row.kind, row.size, row.mode, row.uid, row.gid, row.atime, row.mtime, row.ctime, row.ino, row.rev, null, row.dev, row.nlink);
        unlisted.delete(dir);
    };
    /** The mark a directory a learning makes takes: the mount the nearest marked directory above it is on, or its own name. */
    const learnedMark = (k) => {
        for (let at = nsParent(k);; at = nsParent(at)) {
            // A directory learned without its entries is marked with its own name: that says nothing of a mount above.
            const mount = unlisted.get(at);
            if (mount !== undefined && mount !== at)
                return mount;
            if (at === '')
                return k;
        }
    };
    const markReady = (t, isReady, why) => {
        t.metaSet('ns', isReady ? '1' : '0');
        ok = !!isReady;
        if (!isReady) {
            cause = stringOf(why || 'a change it could not follow');
            generation++;
        }
    };
    const refuse = (t, why) => {
        markReady(t, false, why);
        throw objectAssign(new Error(why), { code: 'ENOSPC' });
    };
    /**
     * The mount a lookup of `k` lands on unlisted: the mount point of the
     * nearest directory the namespace holds at `k` (when `self`) or above
     * it, when that directory is unlisted, or null. A listed directory is known
     * whatever is above it: a device mount that resolves its own paths can show
     * a directory whose parents it will not list.
     */
    const unlistedOver = (k, self) => {
        if (unlisted.size === 0)
            return null;
        const t = coherence.require();
        for (let at = self ? k : nsParent(k); at !== ''; at = nsParent(at)) {
            const mount = unlisted.get(at);
            if (mount !== undefined)
                return mount;
            const row = nsRowAt(t, at);
            if (row && row.kind === NS_DIR)
                return null;
        }
        return null;
    };
    /**
     * `unlisted` is what a listing says of a directory: the mount point it is
     * on when it did not name its entries, null when it did. Undefined (a delta,
     * a note) keeps what the row says.
     */
    const put = (t, k, stat, rev, target, unlistedAt) => {
        const parent = nsParent(k);
        const name = nsName(k);
        const kind = nsKindCode(stat.type);
        const mount = kind !== NS_DIR ? null : unlistedAt === undefined ? (unlisted.get(k) ?? null) : unlistedAt;
        const stored = kind === NS_LINK ? stringOf(target ?? '') : mount;
        // A one-shot's heap holds the namespace within its one budget: a row that would not fit is not written.
        const heap = coherence.heap;
        if (heap !== null && admission.inHeap) {
            const refused = admission.rowRefusal(heap.nsGrowth(parent, name, stored));
            if (refused !== null)
                refuse(t, refused);
        }
        const ino = NumberOf(stat.ino) || 0;
        const dev = NumberOf(ownValue(stat, 'dev')) || 0;
        t.nsPut(parent, name, kind, NumberOf(stat.size) || 0, NumberOf(stat.mode) || 0, NumberOf(stat.uid) || 0, NumberOf(stat.gid) || 0, NumberOf(stat.atime) || 0, NumberOf(stat.mtime) || 0, NumberOf(stat.ctime) || 0, ino, NumberOf(rev) || 0, stored, dev, NumberOf(ownValue(stat, 'nlink')) || 1);
        if (kind === NS_LINK)
            links.add(k);
        else
            links.delete(k);
        if (mount !== null)
            unlisted.set(k, mount);
        else
            unlisted.delete(k);
        putListener?.(k, dev, ino);
    };
    // The authority operation may succeed while metadata cannot be cached.
    // A heap put refused for room has sealed the sync view; keep the async result.
    const tryPut = (t, k, stat, rev, target, unlistedAt) => {
        try {
            put(t, k, stat, rev, target, unlistedAt);
            return true;
        }
        catch (error) {
            if (admission.inHeap && error !== null && (typeof error === 'object' || typeof error === 'function') && ownField(error, 'code') === 'ENOSPC')
                return false;
            throw error;
        }
    };
    const forgetListed = (dir) => {
        const prefix = dir === '' ? '' : dir + '/';
        listed.forEach((done) => { if (done === dir || stringStartsWith(done, prefix))
            listed.delete(done); });
    };
    /** Delete everything beneath `k`, and `k` itself when `self`. */
    const deleteTree = (t, k, self) => {
        // What a lazily listed namespace held there is no longer all of it.
        if (lazy)
            forgetListed(k);
        if (k === '') {
            t.nsClear();
            links = new SafeSet();
            unlisted = new SafeMap();
            return;
        }
        const prefix = k + '/';
        const end = prefixEnd(prefix);
        t.nsDeleteChildren(k);
        t.nsDeleteParents(prefix, end);
        if (self) {
            const parent = nsParent(k);
            const name = nsName(k);
            t.nsDelete(parent, name);
            links.delete(k);
            unlisted.delete(k);
        }
        links.forEach((link) => { if (stringStartsWith(link, prefix))
            links.delete(link); });
        unlisted.forEach((_mount, dir) => { if (stringStartsWith(dir, prefix))
            unlisted.delete(dir); });
    };
    const forget = (t, k) => {
        const parent = nsParent(k);
        const name = nsName(k);
        t.nsDelete(parent, name);
        links.delete(k);
        unlisted.delete(k);
    };
    function lookup(k, followLeaf, own, visit) {
        return walkNamespace(coherence.require(), links, k, followLeaf, own, visit);
    }
    /** Whether the credential may search directory `row` (POSIX x). */
    const traversable = (row) => {
        if (!row || row.kind !== NS_DIR)
            return false;
        return namespaceAllows(cred, row, 'directory', 1);
    };
    const children = (k) => {
        const rows = coherence.require().nsChildren(k);
        const out = new SafeList();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            out[out.length] = { name: stringOf(row.name), kind: NumberOf(row.kind), mode: NumberOf(row.mode) };
        }
        // Public readers outside the loading path still use array methods and iteration.
        return arrayCopy(out);
    };
    return {
        bind(t) {
            links = new SafeSet();
            const linkRows = t.nsOfKind(NS_LINK);
            for (let i = 0; i < linkRows.length; i++) {
                const row = linkRows[i];
                const parent = stringOf(row.parent);
                links.add(parent ? parent + '/' + stringOf(row.name) : stringOf(row.name));
            }
            unlisted = new SafeMap();
            const unlistedRows = t.nsUnlisted();
            for (let i = 0; i < unlistedRows.length; i++) {
                const row = unlistedRows[i];
                const parent = stringOf(row.parent);
                unlisted.set(parent ? parent + '/' + stringOf(row.name) : stringOf(row.name), stringOf(row.target));
            }
            ok = t.metaGet('ns') === '1';
        },
        setCred(given) { cred = given || null; },
        get cred() { return cred; },
        ready,
        get ok() { return ok; },
        markReady,
        refuse,
        overlayDelta(bytes) {
            if (!admission.inHeap)
                return;
            const refused = bytes > 0 ? admission.namespaceRefusal(bytes) : null;
            if (refused !== null)
                refuse(coherence.tables('a namespace overlay'), refused);
            admission.addOverlay(bytes);
        },
        rowAt: (k) => nsRowAt(coherence.require(), k),
        notReadyCause() {
            if (!coherence.bound())
                return "the process's store is not bound";
            const sealed = coherence.sealed();
            if (sealed !== null)
                return sealed || 'the store has not reconciled with the session';
            return cause;
        },
        put,
        tryPut,
        deleteTree,
        forget,
        lookup,
        /** `lookup`, with null when nothing is there. */
        resolve(k, followLeaf, own) {
            const found = lookup(k, followLeaf, own);
            if (found === 'ELOOP')
                return found;
            return found.row !== undefined && found.table !== null ? { path: found.table, row: found.row } : null;
        },
        /**
         * The mount point when the namespace cannot say what `k` is: its lookup
         * misses at or under a directory the listing did not name (or, with
         * `listing`, lands on or under one). Null when it knows.
         */
        unknown(k, followLeaf, listing, own) {
            if (unlisted.size === 0)
                return null;
            const found = lookup(k, followLeaf, own);
            if (found === 'ELOOP' || ownValue(found, 'own') !== undefined || found.table === null)
                return null;
            if (found.row === undefined)
                return unlistedOver(found.table, false);
            return listing ? unlistedOver(found.table, true) : null;
        },
        /** The entries directly under directory `k` (already resolved); the mode says what a file kind is. */
        children,
        /**
         * Whether the credential may read the file `stat` describes: what decides
         * whether bytes the store already has are kept for it under a new revision,
         * or a copy is held for it, rather than asked of the session. Equal content
         * keys prove the bytes are the file's, not that this credential may read
         * them, and a chmod or a chown changes no byte. A stat that does not state
         * the mode and owner is no grant: the session is asked instead, and answers.
         */
        readable(stat) {
            if (!stat || !numberIsInteger(NumberOf(ownValue(stat, 'mode'))) || !numberIsInteger(NumberOf(ownValue(stat, 'uid'))) || !numberIsInteger(NumberOf(ownValue(stat, 'gid'))))
                return false;
            return namespaceAllows(cred, stat, 'file', 4);
        },
        /**
         * Apply one delta entry that carries a stat. Returns a directory whose
         * subtree an enumerated namespace must relist — one that just became
         * searchable, whose descendants no delta names — or null.
         */
        applyEntry(t, entry) {
            const k = nsKey(entry.path);
            learnings.forEach((asked) => { asked.reported[asked.reported.length] = k; });
            if (k === '')
                return null;
            const stat = ownValue(entry, 'stat');
            if (stat === null) {
                deleteTree(t, k, true);
                return null;
            }
            const before = nsRowAt(t, k);
            if (stat === undefined || !tryPut(t, k, stat, entry.rev, ownValue(entry, 'linkTarget')))
                return null;
            const after = nsRowAt(t, k);
            if (after === undefined || after.kind !== NS_DIR) {
                deleteTree(t, k, false);
                return null;
            }
            const was = before !== undefined && traversable(before);
            const now = traversable(after);
            // Listed on demand, a directory whose names moved without being named
            // (replaced, renamed, its mode or owner changed) is unknown beneath:
            // its names are looked up again.
            if (lazy) {
                if (ownValue(entry, 'structural') || ownValue(entry, 'subtree') || was !== now)
                    deleteTree(t, k, false);
                return null;
            }
            if (was && !now)
                deleteTree(t, k, false);
            if (!was && now && before !== undefined)
                return k;
            return null;
        },
        /**
         * Bring the table to a complete listing: upsert what differs, delete what the
         * listing no longer names. Called once per enumeration, after its last page.
         */
        replace(t, entries) {
            generation++;
            relisting = new SafeMap();
            const names = new SafeSet();
            for (let i = 0; i < entries.length; i++)
                names.add(nsKey(entries[i].path));
            // Remove stale rows before admitting replacements; do not transiently
            // charge both versions of a complete namespace against the fixed cap.
            const rows = t.nsKeys();
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const parent = stringOf(row.parent);
                const k = parent ? parent + '/' + stringOf(row.name) : stringOf(row.name);
                if (!names.has(k))
                    forget(t, k);
            }
            // Free shrinking text before growing another surviving row; final-state
            // admission must not depend on alphabetical replacement order.
            if (admission.inHeap) {
                for (let i = 0; i < entries.length; i++) {
                    const entry = entries[i];
                    const k = nsKey(entry.path);
                    if (!k)
                        continue;
                    const parent = nsParent(k);
                    const name = nsName(k);
                    const held = t.nsGet(parent, name);
                    const linkTarget = ownValue(entry, 'linkTarget');
                    const unlistedAt = ownValue(entry, 'unlisted');
                    if (held && namespaceRowBytes(parent, name, held.target) > namespaceRowBytes(parent, name, linkTarget ?? unlistedAt)) {
                        put(t, k, entry.stat, entry.rev, linkTarget, unlistedAt ?? null);
                    }
                }
            }
            for (let i = 0; i < entries.length; i++) {
                const entry = entries[i];
                const k = nsKey(entry.path);
                if (k === '')
                    continue;
                names.add(k);
                const held = nsRowAt(t, k);
                const s = entry.stat;
                const linkTarget = ownValue(entry, 'linkTarget');
                const unlistedAt = ownValue(entry, 'unlisted');
                if (held !== undefined
                    && held.kind === nsKindCode(s.type) && held.size === NumberOf(s.size)
                    && held.mode === NumberOf(s.mode) && held.uid === NumberOf(s.uid)
                    && held.gid === NumberOf(s.gid) && held.mtime === NumberOf(s.mtime)
                    && held.ctime === NumberOf(s.ctime) && held.ino === NumberOf(s.ino)
                    && held.dev === (NumberOf(s.dev) || 0) && held.rev === NumberOf(entry.rev)
                    && (held.target ?? null) === (linkTarget ?? unlistedAt ?? null))
                    continue;
                put(t, k, s, entry.rev, linkTarget, unlistedAt ?? null);
            }
        },
        /**
         * Record this facet's own acknowledged write in the namespace before the
         * delta that reports it: a file it created is then listed at once. Only
         * when the table has nothing as new, so an authority stat already applied at
         * or past `rev` is never overwritten by this approximation; the delta that
         * reports the write replaces it with the authority's stat.
         */
        noteOwnFile(k, size, rev) {
            if (!ready())
                return;
            const t = coherence.require();
            const held = nsRowAt(t, k);
            if (held !== undefined && held.rev >= rev)
                return;
            const now = realNow();
            // A file the process created: its umask's mode, on the device of the
            // directory it is in, with one link, until the delta reports the
            // authority's own stat for it. A file it rewrote keeps its identity.
            const slash = stringLastIndexOf(k, '/');
            const parent = held === undefined ? nsRowAt(t, slash < 0 ? '' : stringSlice(k, 0, slash)) : undefined;
            tryPut(t, k, {
                type: 'file', size, mode: held ? held.mode : 0o100666 & ~NumberOf((cred === null ? undefined : ownValue(cred, 'umask')) ?? 0o022),
                uid: held ? held.uid : NumberOf(cred === null ? 0 : cred.uid),
                gid: held ? held.gid : NumberOf(cred === null ? 0 : cred.gid),
                atime: now, mtime: now, ctime: now, ino: held ? held.ino : 0,
                dev: held ? held.dev : parent?.dev, nlink: held ? held.nlink : 1,
            }, rev, null);
        },
        /**
         * Record what the authority just said of a name this process asked about (an
         * async stat, read or accepted write): the sync view answers it at once,
         * as it would after the delta that reports it. Dated at the store's cursor,
         * so any row as new is kept, and the next delta naming the path replaces it
         * with the authority's own dating. `stat` null: the authority said it is not
         * there, and a row older than the cursor goes. The caller has checked that no
         * barrier reported the path while the stat was out (node-shims
         * _noteLearnedStat).
         *
         * `written`: the revision of this process's own accepted write the stat was
         * taken after, and the row's date. The row noteOwnFile approximated for
         * that write is dated there too, so the authority's stat replaces it (the
         * owner of a file the process overwrote without having listed it is the
         * authority's, not the process's), and only a row newer than the write is
         * kept.
         *
         * A symlink's stat does not say where the link points, so it is not kept:
         * a row without its target would resolve the link to its own directory.
         */
        noteLiveStat(k, stat, written) {
            if (!ready())
                return;
            const cursor = coherence.cursor();
            if (cursor === null)
                return;
            const t = coherence.require();
            const held = nsRowAt(t, k);
            if (held !== undefined && (written === undefined ? held.rev >= cursor.rev : held.rev > written))
                return;
            if (stat === null) {
                if (held !== undefined)
                    forget(t, k);
                return;
            }
            if (!nsDescribes(stat))
                return;
            const target = ownValue(stat, 'linkTarget') ?? ownValue(stat, 'target') ?? null;
            if (stat.type === 'symlink' && target === null)
                return;
            tryPut(t, k, stat, written ?? cursor.rev, target);
        },
        clear() {
            generation++;
            relisting = new SafeMap();
            links = new SafeSet();
            unlisted = new SafeMap();
            ok = false;
        },
        get lazy() { return lazy; },
        beginLazy() {
            generation++;
            relisting = new SafeMap();
            lazy = true;
            listed.clear();
            links = new SafeSet();
            unlisted = new SafeMap();
        },
        listedAt(k) { return isListed(nsParent(k)); },
        isListed,
        markListed,
        learn(t, k, stat, rev, target) {
            if (lazy || stat.type !== 'directory' || nsRowAt(t, k) !== undefined)
                return tryPut(t, k, stat, rev, target);
            return tryPut(t, k, stat, rev, target, learnedMark(k));
        },
        fence(dir) { relisting.set(dir, (relisting.get(dir) ?? 0) + 1); },
        relisted(dir) {
            const count = relisting.get(dir) ?? 0;
            if (count <= 1)
                relisting.delete(dir);
            else
                relisting.set(dir, count - 1);
            if (!lazy && unlisted.get(dir) === dir)
                markListed(dir);
        },
        fenced,
        spoilLearnings() { generation++; },
        onPut(listener) {
            putListener = listener;
        },
        learning() {
            const asked = { generation, reported: new SafeList() };
            learnings.add(asked);
            const named = (k, beneath) => {
                for (let i = 0; i < asked.reported.length; i++) {
                    const at = asked.reported[i];
                    if (at === '' || at === k || stringStartsWith(k, at + '/') || (beneath && (k === '' || stringStartsWith(at, k + '/'))))
                        return true;
                }
                return false;
            };
            return {
                installs: (k) => asked.generation === generation && !named(k, false),
                lists: (dir) => asked.generation === generation && !named(dir, true),
                end: () => { learnings.delete(asked); },
            };
        },
    };
}
