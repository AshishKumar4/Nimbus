/**
 * The store as a process's filesystem adapter reads it (core
 * runtime/wasi/resident-filesystem.ts, ResidentNamespace), for both kinds of
 * namespace a store holds:
 *
 * - **Listed on demand** (a WASI guest, parked under JSPI): it starts with no
 *   names at the authority's cursor and lists a directory the first time a
 *   lookup needs one of its entries (namespace.ts). A barrier that cannot be
 *   applied starts it again from nothing.
 * - **Enumerated** (node, eagerly booted from its data plan): every name the
 *   launch listed, absent below a directory unless a mount left it unlisted.
 *   A barrier that cannot be applied is repaired: from the durable floor, or
 *   by listing again (sync.synchronize). What a delta drops that the store
 *   held is fetched again before the barrier lands, so a synchronous read
 *   right after it finds the new bytes, not a miss.
 *
 * One barrier for both: it asks (or takes the answer a delivery carried),
 * applies, and differs only in how it repairs what it could not apply.
 */
import { nsRowAt } from './namespace.js';
import { NS_DIR, NS_LINK, RK_OWN_WRITE } from './tables.js';
/** The most a lookup reads of the file it ends at, so the open that follows a stat costs no trip of its own. */
const LOOKUP_CONTENT_BYTES = 256 * 1024;
/**
 * Repairs someone else started that one barrier waits on, in a row, before it
 * stops asking again and drops what it cannot vouch for. A bound on the
 * barrier's own liveness: each join waits a whole repair, so the fourth means
 * repairs keep being started under it.
 */
const REPAIR_JOINS_MAX = 4;
export function createView(coherence, admission, namespace, cells, transport, sync, pages) {
    /**
     * Start a namespace with no names at `cursor`, to be listed on demand. Every
     * row and held file goes: nothing here is dated against the new cursor.
     */
    const beginLazy = (t, cursor) => {
        namespace.beginLazy();
        t.clear();
        pages.reset();
        cells.dropHeld(true);
        coherence.writeCursor(t, cursor);
        coherence.unseal();
        coherence.setUndated(false);
        namespace.markReady(t, true);
    };
    /**
     * Boot a lazily listed namespace: the authority's current cursor (an ACQUIRE
     * from no cursor is a poison by construction, which carries it) and no
     * names. False when no cursor came back: the process then asks the
     * authority for everything, as it did before this store.
     */
    const bootLazy = async (supervisor) => {
        if (!supervisor || typeof supervisor.fsAcquire !== 'function')
            return false;
        let answer = null;
        try {
            answer = await supervisor.fsAcquire(null, 0, { namespace: true });
        }
        catch {
            return false;
        }
        if (!answer || typeof answer.epoch !== 'string' || typeof answer.rev !== 'number')
            return false;
        // Sealed until now, and this is what unseals it: nothing is held to date.
        beginLazy(coherence.tables('bootLazy'), { epoch: answer.epoch, rev: answer.rev });
        return true;
    };
    /**
     * An answer as it stands against the store's cursor now. Answers can be
     * admitted in another order than they were given (one a delivery carried
     * was asked before a barrier that overtook it); everything at or below the
     * cursor is admitted already, so only the entries above it are news, and
     * the cursor never moves back. An answer in another epoch, or a poison, is
     * left as it is.
     */
    const current = (answer) => {
        const cursor = coherence.cursor();
        if (cursor === null || answer.poison === true || answer.epoch !== cursor.epoch)
            return answer;
        if (answer.rev <= cursor.rev)
            return { ...answer, rev: cursor.rev, paths: [] };
        const paths = answer.paths.filter((entry) => entry.rev > cursor.rev);
        return paths.length === answer.paths.length ? answer : { ...answer, paths };
    };
    /**
     * The answer a delivery carried, as it stands now, or null when it cannot
     * stand in for asking: it can when it answers from a cursor the store has
     * reached, in its epoch, and names everything after it up to the delivery.
     * A routed request is answered from the session's own cursor, "nothing
     * since now", which stands in only for a store already there.
     */
    const delivered = (given) => {
        if (!given || typeof given !== 'object')
            return null;
        const { args, answer } = given;
        const cursor = coherence.cursor();
        if (cursor === null || !args || !answer || answer.poison === true || !Array.isArray(answer.paths))
            return null;
        if (typeof answer.rev !== 'number' || answer.epoch !== cursor.epoch || args.epoch !== cursor.epoch)
            return null;
        if (!(args.cursor <= cursor.rev))
            return null;
        return current(answer);
    };
    return {
        bootLazy,
        /**
         * The store as a process's filesystem adapter reads it: names as lstats,
         * file bytes held or fetched, and the barrier. `device` is the session's
         * SQLite device, the only one the adapter answers for.
         */
        namespaceView(supervisor, device, cred) {
            namespace.setCred(cred);
            const encoder = new TextEncoder();
            const typeOf = (kind) => (kind === NS_DIR ? 'directory' : kind === NS_LINK ? 'symlink' : 'file');
            /** What an ACQUIRE is asked with: the store's cursor, and the push roots it keeps (sync.acquireOptions). */
            const argsNow = () => {
                const cursor = coherence.cursor();
                return cursor === null ? null : { epoch: cursor.epoch, cursor: cursor.rev, options: sync.acquireOptions() };
            };
            /**
             * One ACQUIRE from the store's cursor, as it stands now; null when there
             * is none (the call failed past the supervisor's own retries, or the
             * answer carried no cursor). A lease asked with it is the asker's from
             * the moment it is answered, whatever the barrier does with the answer.
             */
            const acquire = async (lease) => {
                const args = argsNow();
                if (args === null || typeof supervisor.fsAcquire !== 'function')
                    return null;
                let answer = null;
                try {
                    answer = await supervisor.fsAcquire(args.epoch, args.cursor, lease ? { ...args.options, lease: true } : args.options);
                }
                catch {
                    return null;
                }
                if (!answer || typeof answer.epoch !== 'string' || typeof answer.rev !== 'number')
                    return null;
                if (lease && answer.readLease)
                    lease.answered(answer.readLease);
                return current(answer);
            };
            /**
             * A barrier whose answer could not be applied, on a namespace listed on
             * demand: it starts again from nothing at the answer's cursor (or the
             * session's, when there was none to take).
             */
            const restart = async (answer, applied) => {
                if (answer === null)
                    return bootLazy(supervisor);
                if (applied && namespace.ready())
                    return true;
                beginLazy(coherence.tables('restart'), applied ? coherence.cursor() : { epoch: answer.epoch, rev: answer.rev });
                return true;
            };
            /**
             * Set while the store holds only what a repair could NOT vouch for: rows
             * it had to drop rather than prove current. Nothing but another repair
             * brings those back (a delta names what changed, not what this store
             * lost), so every barrier repairs until one vouches.
             */
            let repairOwed = false;
            /** The repair running, which every barrier answered meanwhile joins: no delta is admitted under one. */
            let repairing = null;
            /**
             * The repair's first try: the delta from the store's durable floor, in
             * its epoch. True when it applied (the repair is done); false when a
             * listing is needed after all.
             */
            const repairFromFloor = async (answer) => {
                if (typeof supervisor.fsAcquire !== 'function' || !namespace.ready())
                    return false;
                if (answer !== null && answer.poison === true)
                    return false;
                const floor = coherence.cursor();
                if (floor === null || (answer !== null && answer.epoch !== floor.epoch))
                    return false;
                let delta = null;
                try {
                    delta = await supervisor.fsAcquire(floor.epoch, floor.rev, { namespace: true });
                }
                catch {
                    return false;
                }
                if (!delta || delta.poison === true || typeof delta.rev !== 'number' || delta.epoch !== floor.epoch)
                    return false;
                const applied = await sync.applyAcquire(supervisor, delta);
                if (!namespace.ready())
                    return false;
                // What it should hold and lost (dropped by this delta, or by the barrier
                // that could not vouch for its rows), fetched again by the namespace's stats.
                await sync.refillFromNamespace(supervisor, applied.dropped);
                repairOwed = false;
                return true;
            };
            /**
             * `answer` is the ACQUIRE answer that asked for the repair: a poison, a
             * delta arriving while a repair is owed, or null for a barrier that got
             * no answer at all. Within one epoch, with the change log intact and the
             * namespace answering, the delta from the durable floor names everything
             * that moved since; only an epoch change, a poison (the log truncated
             * past the cursor), or a namespace that stopped answering needs the
             * listing, which keeps every row it proves current (sync.synchronize).
             */
            const runRepair = async (answer) => {
                if (await repairFromFloor(answer))
                    return;
                let repaired = null;
                try {
                    repaired = await sync.synchronize(supervisor);
                }
                catch {
                    repaired = null;
                }
                if (!repaired || !repaired.cursor) {
                    // The pass could not vouch for a single row (a supervisor replaced
                    // mid-enumeration, a listing that came back short, an authority it
                    // could not reach). A row that cannot be dated is not served: an
                    // answer with a cursor is admitted as it would have been, a barrier
                    // with none drops every dated row and keeps its cursor (the next
                    // delta is still owed from there), and the pass runs once more to
                    // repopulate what that dropped.
                    if (answer !== null)
                        cells.admit(answer);
                    else
                        cells.dropDated();
                    try {
                        repaired = await sync.synchronize(supervisor);
                    }
                    catch {
                        repaired = null;
                    }
                }
                repairOwed = !(repaired && repaired.cursor);
            };
            const repair = (answer) => {
                if (repairing === null)
                    repairing = runRepair(answer).finally(() => { repairing = null; });
                return repairing;
            };
            /**
             * The newest refetch of each key, at the revision it was issued for:
             * every barrier waits on those in flight when it began as well as its
             * own, so a call that cannot wait, right after any barrier, finds a
             * file the store held at its new bytes, not a miss.
             */
            const refetching = new Map();
            /**
             * Fetch again, at their revisions now, the keys a delta dropped. A
             * refetch a later delta superseded is refused its install (its ticket);
             * it waits once more, on the newer refetch of its key and on a repair
             * running, then settles held or not: following every newer refetch
             * would hold each resumption while a peer rewrites faster than a read.
             */
            const refetch = (keys) => {
                if (keys.length === 0)
                    return [];
                const read = sync.refillFromNamespace(supervisor, keys).catch(() => undefined);
                const t = coherence.require();
                return keys.map((k) => {
                    const record = { rev: nsRowAt(t, k)?.rev ?? 0, read, done: Promise.resolve() };
                    record.done = read.then(() => {
                        const newer = refetching.get(k);
                        return Promise.all([newer !== undefined && newer !== record ? newer.read : undefined, repairing ?? undefined]);
                    }).then(() => undefined, () => undefined).finally(() => { if (refetching.get(k) === record)
                        refetching.delete(k); });
                    refetching.set(k, record);
                    return record.done;
                });
            };
            /**
             * The barrier on an enumerated namespace. A namespace that stopped
             * answering (a relist failed) is a failure state, not a mode: every
             * barrier repairs it, once, until a listing restores it. Any barrier
             * answered while a repair runs joins it and then asks again: a delta from
             * the repaired cursor names everything since, and the listing may
             * predate this barrier's own answer. Only the barrier that started a
             * repair resumes on it alone, asking once more because a listing is
             * walked page by page at successive revisions; unanswered, it resumes on
             * the rows the listing vouched for.
             */
            const enumerated = async (first, lease) => {
                const joined = [...refetching.values()].map((record) => record.done);
                let answer = first;
                let namespaceAsked = false;
                let repaired = false;
                for (let joins = 0;; joins++) {
                    const joining = repairing !== null;
                    const namespaceOwed = !namespaceAsked && !namespace.ready();
                    const needsRepair = answer === null || answer.poison === true || repairOwed || namespaceOwed;
                    if (!joining && !needsRepair)
                        break;
                    repaired = true;
                    if (namespaceOwed)
                        namespaceAsked = true;
                    await (joining ? repairing : repair(answer));
                    if (!joining) {
                        if (repairOwed)
                            return { landed: false };
                        answer = await acquire(lease);
                        if (answer === null || answer.poison === true)
                            return { landed: namespace.ready() };
                        continue;
                    }
                    if (joins + 1 >= REPAIR_JOINS_MAX) {
                        // Every repair this barrier waited on was someone else's. Rather
                        // than resume on rows none of them vouched for as of its own
                        // answer, it drops them and leaves the repair owed: a colder
                        // cache, never a stale byte.
                        cells.dropDated();
                        repairOwed = true;
                        return { landed: false };
                    }
                    answer = await acquire(lease);
                }
                const applied = await sync.applyAcquire(supervisor, answer);
                if (!namespace.ready())
                    return { landed: false };
                // What it held and the delta dropped, fetched again at its new revision, and every refetch it found in flight.
                await Promise.all([...refetch(applied.dropped), ...joined]);
                return answer.readLease ? { landed: true, applied: !repaired, readLease: answer.readLease } : { landed: true, applied: !repaired };
            };
            /** The barrier on a namespace listed on demand: one it cannot apply starts it again from nothing. */
            const lazily = async (answer) => {
                if (answer === null || answer.poison === true)
                    return { landed: await restart(answer, false), applied: false };
                await sync.applyAcquire(supervisor, answer);
                // A lease vouches for the answer applied: not for a namespace started again from nothing.
                const applied = namespace.ready();
                const landed = await restart(answer, true);
                return applied && answer.readLease ? { landed, applied, readLease: answer.readLease } : { landed, applied };
            };
            const view = {
                device: Number(device),
                cred: { uid: Number(cred.uid), gid: Number(cred.gid), groups: (cred.groups || []).map(Number) },
                ready: () => namespace.ready(),
                entry(k) {
                    // Under a directory whose relist is on its way, no row is answered, nor any absence.
                    if (namespace.fenced(k))
                        return undefined;
                    const row = nsRowAt(coherence.require(), k);
                    if (row === undefined)
                        return namespace.listedAt(k) ? null : undefined;
                    return {
                        type: typeOf(row.kind), dev: row.dev || 0, ino: row.ino, nlink: row.nlink || 1,
                        size: row.size, atime: row.atime, mtime: row.mtime, ctime: row.ctime,
                        mode: row.mode, uid: row.uid, gid: row.gid, revision: row.rev,
                        target: row.target == null ? null : String(row.target),
                    };
                },
                children(k) {
                    if (!namespace.isListed(k))
                        return undefined;
                    return namespace.children(k).map((child) => ({ name: child.name, type: typeOf(child.kind) }));
                },
                list: (k) => transport.listDirectory(supervisor, k),
                lookup: (keys, content) => transport.lookupKeys(supervisor, keys, content ? LOOKUP_CONTENT_BYTES : 0),
                listTree: (k) => transport.listSubtree(supervisor, k),
                content(k, revision) {
                    // Bytes older than the revision the caller saw are not its file's.
                    if (revision !== undefined) {
                        const stamped = cells.provenance(k);
                        if (stamped !== undefined && stamped !== RK_OWN_WRITE && stamped < revision)
                            return undefined;
                    }
                    const cell = cells.get(k);
                    if (cell === undefined || (typeof cell === 'object' && 'error' in cell))
                        return undefined;
                    return typeof cell === 'string' ? encoder.encode(cell) : cell;
                },
                async fill(k, entry) {
                    const cursor = coherence.cursor();
                    if (cursor === null)
                        return null;
                    await transport.fetchFiles(supervisor, [{ path: k, size: entry.size, rev: entry.revision, epoch: cursor.epoch, ckey: null, version: entry }]);
                    const bytes = view.content(k, entry.revision);
                    return bytes === undefined ? null : bytes;
                },
                pages: (k, rev, size, first, last) => pages.read(supervisor, k, rev, size, first, last),
                // Many files in batched round trips (read-ahead, core runtime/wasi/resident-filesystem.ts).
                async fillMany(files) {
                    const cursor = coherence.cursor();
                    if (cursor === null || files.length === 0)
                        return;
                    await transport.fetchFiles(supervisor, files.map(([k, entry]) => ({ path: k, size: entry.size, rev: entry.revision, epoch: cursor.epoch, ckey: null, version: entry })));
                },
                acquireArgs: () => argsNow(),
                repairOwed: () => repairOwed,
                async barrier(options = {}) {
                    const standIn = options.answer === undefined ? delivered(options.delivered) : null;
                    const answer = options.answer !== undefined ? current(options.answer) : standIn ?? await acquire(options.lease);
                    const result = namespace.lazy ? await lazily(answer) : await enumerated(answer, options.lease);
                    return standIn === null ? result : { ...result, fromDelivery: true };
                },
                cursor: () => coherence.cursor(),
                reserve: (bytes) => admission.pin(bytes),
                release: (bytes) => admission.unpin(bytes),
                // Each row as it is put, the process's (one listener: this view's process, a later one replacing it).
                onAdmitted(listener) {
                    namespace.onPut(listener);
                },
            };
            return view;
        },
    };
}
