/**
 * Bringing the store to the authority: the boot a process takes before its
 * first instruction, the ACQUIRE answers its barriers apply, the reconcile
 * that repairs a poison, and the listings and fetches all of them make.
 *
 * WHAT EXISTS has to come from the authority, not from anything the facet was
 * shipped. That was measured rather than assumed: for a working tree holding a
 * 25 MiB file outside the cwd, the spawn-time stat table this replaced arrived
 * with FOUR entries ("home", "opt", "var", "home/user"), every one a
 * directory. A launch ships only what it staged plus its ancestors; a store
 * that enumerated from that would hold only what the bundle already had, which
 * is the admission problem it exists to delete.
 *
 * One cost this store pays that a heap cache does not: LOSING the rows means
 * repopulating them, not lazily refetching on a miss. That is why the cursor is
 * PERSISTED beside the rows — a fresh incarnation resumes from a real cursor
 * instead of a null epoch, so it asks for a delta rather than inviting a poison
 * — and why a poison RECONCILES the rows against absolute per-path revisions
 * instead of dropping them. The invalidation log a delta rides on is
 * deliberately small (sqlite-vfs.ts, INVALIDATION_LOG_MAX_BYTES) and ordinary
 * write churn trims it past a live cursor as a matter of course, so "poison ⇒
 * full repopulation" made an npm install re-buy the whole filesystem over and
 * over — measured past the DO CPU limit at pi scale. See `synchronize`.
 */
import { residentCellCost } from './cell-cost.js';
import { feedFor, isFeedPosition, rootOf, sameClock } from '@nimbus-sh/core/runtime/feed-position.js';
import { nsDescribes, nsKey, nsRowAt } from './namespace.js';
import { NS_FILE, RK_OWN_WRITE } from './tables.js';
import { messageOf } from './transport.js';
/** Dependencies and VCS state: written in bulk, read through the module map or not at all. */
const PUSH_EXCLUDE = ['node_modules', '.git'];
export function createSync(coherence, admission, namespace, cells, transport) {
    /**
     * The acquire options this store asks for: stats with every delta entry, and
     * the content of files changed under the push roots — the process's working
     * tree and /tmp, where what a peer writes after launch is what it goes on to
     * read (build output, manifests, temp files), less dependencies and VCS state.
     */
    let pushRoots = [];
    /**
     * The launch's data plan (facets/data-plan.ts): the paths whose content a
     * synchronous read may want, held from boot beside the module map. A launch
     * with none (a re-entry by an inbound request) holds what it already had.
     */
    let plan = new Set();
    /**
     * Every package.json the launch's listing names, held from boot: the data
     * plan's `package-json` rule (facets/data-plan.ts) for a launch the session
     * plans without a listing (a one-shot). Package resolution reads manifests
     * synchronously, for whatever names a program resolves, which no closure
     * walk bounds: vite's config load resolves every import of the config to
     * decide what to externalize, and took each manifest it was refused for a
     * package that is not installed.
     *
     * The launch hands over the manifests the session read once per install
     * (manager.ts _installedManifests), by path, each with its content key. A
     * listed manifest whose content key is its copy's, and whose listed mode and
     * owner let this credential read it, is held from the copy, so a copy is
     * never older than the file nor readable where the file is not; any other
     * is fetched with the plan.
     * Null: no such rule (a resident's plan names its manifests itself).
     */
    let manifests = null;
    const isManifest = (path) => (path === 'package.json' || path.endsWith('/package.json')) && !('/' + path).includes('/.git/');
    const pushable = (path) => {
        for (const root of pushRoots) {
            if (root !== '' && path !== root && !path.startsWith(root + '/'))
                continue;
            const rest = root === '' ? path : path.slice(root.length + 1);
            if (!rest.split('/').some((seg) => PUSH_EXCLUDE.includes(seg)))
                return true;
        }
        return false;
    };
    const acquireOptions = () => (pushRoots.length > 0
        ? { namespace: true, push: { roots: pushRoots, exclude: PUSH_EXCLUDE } }
        : { namespace: true });
    /**
     * Apply one ACQUIRE answer to the store: room for what it pushes (N18), the
     * delta itself, then the directories it says no delta will itemise, relisted
     * where the namespace is enumerated (one listed on demand forgets what is
     * beneath them as it applies the delta). The store's catch-up and a
     * WASI process's barrier run it; node-shims.ts's barriers run the same three
     * steps inline.
     */
    const applyAcquire = async (supervisor, result) => {
        await admission.roomForPushed(result);
        const applied = cells.admit(result);
        for (const dir of applied.relist)
            await transport.relist(supervisor, dir);
        return applied;
    };
    /**
     * One delta from a listing's cursor, applied before the program runs. A
     * listing's pages are walked at successive revisions, so the namespace it
     * builds can mix states no single revision had (a rename seen on both sides
     * or neither); the delta from its cursor names every path that moved during
     * the walk, and leaves the table exact at the delta's revision. At boot there
     * are no own writes, so nothing here needs the ledger's report notes.
     */
    const catchUp = async (supervisor, cursor) => {
        if (!supervisor || typeof supervisor.fsAcquire !== 'function')
            return cursor;
        let result;
        try {
            result = await supervisor.fsAcquire(cursor, acquireOptions());
        }
        catch {
            result = null;
        }
        if (!result || result.poison || !isFeedPosition(result.position)) {
            // Unanswered: the namespace keeps the listing's revision, which the
            // program's first barrier brings forward like any other.
            return cursor;
        }
        const applied = await applyAcquire(supervisor, result);
        // A dropped row was held, so it is wanted again at its new revision.
        const refetch = [];
        for (const path of applied.dropped) {
            const found = namespace.resolve(path, false);
            if (!found || found === 'ELOOP' || found.row.kind !== NS_FILE)
                continue;
            refetch.push({ path, size: found.row.size, rev: found.row.rev, epoch: rootOf(applied.cursor).epoch, version: versionOf(found.row) });
        }
        if (refetch.length > 0)
            await transport.fetchFiles(supervisor, refetch);
        return applied.cursor;
    };
    /**
     * Bring the store to the authority's current state — the one repair path, used
     * both to populate a facet before its first instruction and to recover a
     * poisoned cursor.
     *
     * It turns "a capped prefetch" into "the filesystem", which is what makes a
     * first synchronous read of an untouched file succeed, and it is the only
     * blocking step: the waiting is done here so the reads that follow never have
     * to.
     *
     * WHY A POISON DOES NOT DROP THE ROWS. A poison says only that
     * `invalidatedSince` cannot describe the distance from our cursor to now —
     * the invalidation log is bounded at 256 KiB (sqlite-vfs.ts) and ordinary
     * write churn trims it past a live cursor as a matter of course. It says
     * nothing about the rows, and the rows are the asset: at pi scale ~16k files
     * and ~96 MB that dropping forces back over the wire, awaited inside the
     * ACQUIRE barrier, on every poison. That is a cost defect, not a coherence
     * one, and it was measured taking an agent turn past the DO CPU limit.
     *
     * `fsList` does not touch the log and reports every path's ABSOLUTE
     * revision, which is strictly more information than a delta. So the rows are
     * RECONCILED instead: a row at or above its listed revision is proven current
     * and kept, a row below it or no longer listed goes, and only what actually
     * moved is refetched. Every surviving row is vouched for by revision, so the
     * no-stale-byte guarantee is exactly as unconditional as it was on the drop
     * path — the delta is simply not the only way to establish it.
     *
     * The comparison is sound ONLY within one supervisor incarnation and ONLY
     * against a complete enumeration:
     *
     *   - revisions from different epochs are unrelated clocks, and after a
     *     restart an untouched path lists at rev 0, which would vouch for anything;
     *   - a truncated listing cannot tell a path that was REMOVED from one that
     *     was never walked, so dropping unlisted rows against it would delete a
     *     live cache for no reason.
     *
     * Neither is verifiable ⇒ nothing is dropped and nothing is vouched for; the
     * pass degrades to filling what the store does not hold, which is exactly what
     * it did before rows could be verified. The caller keeps whatever cursor it
     * had, and a poisoned caller has already taken its cold cache through
     * cells.admit.
     *
     * A row stamped RK_OWN_WRITE is this facet's own unacknowledged bytes —
     * newer than anything the authority can report — and is kept whether listed
     * or not, the same read-your-writes rule the delta path applies. But the
     * pass moves the cursor without a delta, so the report a delta would have
     * carried for such a path is returned instead (`own`): the listed revision,
     * or the listing's own cursor for a path it no longer lists, which bounds
     * whatever removed it. The write or mutation that owns the row adjudicates it
     * when its revision arrives, exactly as it does a delta's report. Across
     * incarnations, or against a short listing, no report can be dated and each
     * comes back null.
     *
     * Writes landing DURING the pass are covered the way they always were: the
     * published cursor is the one read BEFORE the walk, so they report revisions
     * above it and the next ACQUIRE evicts whatever they touched.
     */
    const synchronize = async (supervisor) => {
        const t = coherence.tables('synchronize');
        if (!supervisor || typeof supervisor.fsReadBatch !== 'function') {
            return { requested: 0, filled: 0, failed: 0, skipped: 'no fsReadBatch on this supervisor' };
        }
        if (typeof supervisor.fsList !== 'function') {
            // Without the enumeration the store cannot know what it is missing, so it
            // fills nothing beyond the adopted bundle and every read behaves exactly
            // as it did before this store existed — a smaller resident set, never a
            // wrong one. That is the failure direction to keep.
            return { requested: 0, filled: 0, failed: 0, skipped: 'supervisor cannot enumerate the filesystem (no fsList)' };
        }
        let listing;
        try {
            listing = await transport.enumerate(supervisor);
        }
        catch (e) {
            return { requested: 0, filled: 0, failed: 0, skipped: 'fsList failed: ' + messageOf(e) };
        }
        if (!listing.cursor) {
            return { requested: 0, filled: 0, failed: 0, skipped: 'fsList reported no authority cursor' };
        }
        const held = coherence.cursor();
        // May a row this pass cannot prove current be DROPPED? Only against a
        // complete enumeration: a truncated one cannot tell a path that was removed
        // from one that was never walked.
        const judgeable = listing.complete;
        const describable = judgeable && listing.names.every((entry) => nsDescribes(entry.stat));
        // May a held revision of `path` be COMPARED with a listed one? Only on one
        // clock: its feed in one incarnation. Across a restart the clocks are
        // unrelated, and an untouched path lists at rev 0, which would vouch for anything.
        const at = listing.cursor;
        const comparable = (path) => judgeable && held !== null && sameClock(held, at, path);
        // A file listed at revision 0 has none the store can compare: a mounted
        // file's (its backend keeps no revision on the session's clock; a file
        // SQLite holds was written at a generation past 0). Its row is never
        // vouched for, so a reconcile refetches what the mount holds now.
        const vouches = (entry, rev) => entry !== undefined && comparable(entry.path) && entry.rev > 0 && rev >= entry.rev;
        const listed = new Map();
        for (const file of listing.entries)
            listed.set(file.path, file);
        const rows = t.fileRows();
        const current = new Set();
        const dropped = [];
        const own = [];
        let rekeyed = 0;
        for (const row of rows) {
            const entry = listed.get(row.path);
            if (row.rev === RK_OWN_WRITE) {
                current.add(row.path);
                own.push({
                    path: row.path,
                    rev: !comparable(row.path) ? null : entry !== undefined ? entry.rev : feedFor(at, row.path).cursor,
                });
                continue;
            }
            const keep = vouches(entry, row.rev) || !judgeable;
            if (keep) {
                current.add(row.path);
                continue;
            }
            // The listing names the same bytes (a revision moved, the content did
            // not, or another epoch): kept and dated at the listing, while its stat
            // says this credential may read them (a chmod or chown moves the
            // revision and no byte). Equal keys are equal bytes, so this needs no
            // comparable clock.
            if (entry !== undefined && row.ckey !== null && entry.ckey != null && row.ckey === entry.ckey && namespace.readable(entry.stat)) {
                t.fileSetRev(row.path, entry.rev);
                current.add(row.path);
                rekeyed++;
                continue;
            }
            dropped.push(row.path);
        }
        // Cells held in the heap (own writes the store had no room for) are judged
        // as file rows are, on every path a file row is (N18). Undated, a write-back
        // still in flight: newer than anything listed, it stays and is reported as
        // own. Dated: kept only where the listing proves it current; otherwise it
        // goes, and is fetched again like any dropped row, so a sync read of it is
        // a miss rather than bytes the authority has replaced.
        for (const [path, rev] of cells.heldRevisions()) {
            if (current.has(path))
                continue;
            const entry = listed.get(path);
            if (rev === RK_OWN_WRITE) {
                current.add(path);
                own.push({ path, rev: !comparable(path) ? null : entry !== undefined ? entry.rev : feedFor(at, path).cursor });
                continue;
            }
            if (vouches(entry, rev) || !judgeable) {
                current.add(path);
                continue;
            }
            cells.forget(path);
            dropped.push(path);
        }
        // Sweep what could not be vouched for. When NOTHING could — a new supervisor
        // incarnation, whose revisions say nothing about ours — that is every row but
        // this facet's own unflushed writes, and at pi scale a per-path delete would
        // be ~32,000 statements in one turn against an object that has been observed
        // resetting under exactly that load. So it is a predicate there, and per path
        // where a reconcile has made the set small by construction.
        if (dropped.length > 0 && !comparable('') && rekeyed === 0) {
            t.dropDatedFiles();
        }
        else {
            for (const path of dropped) {
                t.chunkDelete(path);
                t.fileDelete(path);
            }
        }
        // What to hold: the launch's data plan, every row this pass had to drop as
        // stale — it was held for a reason — and what the pushes a poison lost
        // would have carried: files under the push roots changed since the cursor
        // (all of them there, when the revisions are not comparable).
        const wanted = new Set(dropped);
        const fetch = [];
        const copied = [];
        for (const file of listing.entries) {
            if (current.has(file.path))
                continue;
            if (manifests !== null && isManifest(file.path)) {
                // A copy is the file's bytes (equal content keys) and is held only
                // where the listing says this credential may read them; otherwise the
                // session is asked, and answers.
                const copy = manifests.get(file.path);
                if (Array.isArray(copy) && file.ckey !== null && copy[0] === file.ckey && namespace.readable(file.stat))
                    copied.push({ file, text: String(copy[1]) });
                else
                    fetch.push(file);
                continue;
            }
            if (plan.has(file.path) || wanted.has(file.path)
                || (pushable(file.path) && (!comparable(file.path) || file.rev > feedFor(held, file.path).cursor)))
                fetch.push(file);
        }
        // Reserve mandatory metadata growth while optional data is fetched, but
        // retain the existing namespace publication order across the await.
        const heap = coherence.heap;
        const namespaceGrowth = admission.inHeap && describable && heap !== null ? Math.max(0, listing.namespaceBytes - heap.nsBytes()) : 0;
        const refused = admission.namespaceRefusal(namespaceGrowth);
        if (refused !== null)
            namespace.refuse(t, refused);
        const giveBack = admission.reserveNamespace(namespaceGrowth);
        let filled;
        try {
            // A copy holds the bytes the listing names (equal content keys), dated at
            // its revision; one the store has no room for is fetched like the rest.
            let copiedBytes = 0;
            for (const { text } of copied)
                copiedBytes += residentCellCost(text);
            if (copiedBytes > 0)
                await admission.ensureRoom(copiedBytes);
            for (const { file, text } of copied) {
                if (!cells.put(t, file.path, text, file.rev, file.ckey))
                    fetch.push(file);
            }
            filled = await transport.fetchFiles(supervisor, fetch);
        }
        finally {
            giveBack();
        }
        // The cursor may only advance to a state the rows actually describe, and
        // after a truncated listing they do not: a path in an unwalked page could
        // have moved since the held cursor and would never be reported again.
        if (judgeable) {
            // A listing that cannot describe every name restores the rows it vouches
            // for and the cursor, but not the namespace (see nsDescribes).
            if (describable)
                namespace.replace(t, listing.names);
            coherence.writeCursor(t, listing.cursor);
            namespace.markReady(t, describable, "the session's listing named an entry without its stat");
            coherence.setUndated(false);
            coherence.unseal();
        }
        return {
            requested: filled.requested,
            filled: filled.filled,
            failed: filled.failed,
            bytes: filled.bytes,
            ranges: filled.ranges,
            kept: current.size,
            rekeyed,
            dropped: dropped.length,
            own,
            reconciled: comparable(''),
            complete: listing.complete,
            cursor: judgeable ? listing.cursor : null,
            ...(listing.reason ? { incomplete: listing.reason } : {}),
        };
    };
    /**
     * Adopt the module map's bundle into an EMPTY store — the first fill, and the
     * one that costs nothing extra, because those bytes are already in the facet.
     * The cursor the bundle was read at becomes the store's.
     *
     * Returns the cursor the caller should publish, so there is one answer to
     * "what state does this facet cache" rather than two that can disagree.
     */
    const adoptModuleBundle = (bundle, moduleCursor) => {
        const t = coherence.tables('adoptModuleBundle');
        if (coherence.cursor() !== null) {
            // Adopting over a kept store would re-date its rows at this spawn's
            // cursor without checking one of them. boot reconciles a kept
            // store, or empties it first.
            throw new Error('Nimbus: a module bundle is adopted only into an empty store');
        }
        if (!isFeedPosition(moduleCursor)) {
            // An undated snapshot. Adopt NOTHING and serve an empty store.
            //
            // Not a throw, because this is a real path rather than a misuse: a facet
            // whose first contact is an inbound HTTP request runs
            // `__nimbusEnsureStarted(env, ctx)` with no start args, so it has no
            // cursor to offer. Refusing would turn a served port into a dead one.
            //
            // Not an adopt either, because rows nothing can date are the stale-read
            // bug. An EMPTY store is safe to serve for the reason the seal exists at
            // all — it has no row whose age could be wrong — and a miss is an answer
            // the shims already handle, falling through to the supervisor exactly as
            // they do today after a poison. So this is strictly no worse than the
            // current behaviour and cannot serve a stale byte.
            coherence.setUndated(true);
            coherence.unseal();
            return null;
        }
        for (const path of Object.keys(bundle || {})) {
            cells.put(t, path, bundle[path], feedFor(moduleCursor, path).cursor);
        }
        return cells.admit({ poison: false, paths: [], position: moduleCursor }).cursor;
    };
    const fail = (pass) => (pass && (pass.skipped || pass.incomplete)) || null;
    return {
        /**
         * Make this incarnation's store servable before the program's first
         * instruction. The one boot path the resident body takes.
         *
         * A COLD store — no persisted cursor — adopts this spawn's own snapshot, the
         * module bundle dated at the cursor it was read at, and then fills the rest of
         * the filesystem from the authority. Its rows are current as of the spawn
         * whether or not the fill completes, which is all the protocol asks of a
         * process's first block (§5.3); the first ACQUIRE's delta brings them the rest
         * of the way.
         *
         * A KEPT store holds a PREVIOUS process's rows, dated against a cursor this
         * incarnation has never applied. A durable application's facet is one: it
         * keeps its `app-slot-` name across launches and its release never deletes
         * storage, so every relaunch or re-drive of the application opens what its
         * last process left. The rows are the asset — inside one supervisor
         * incarnation a relaunch fetches what changed, not the filesystem; across two,
         * whose revisions are unrelated, the reconcile rebuilds every dated row — and
         * they are also arbitrarily old: only the reconcile says which of them still
         * describe the filesystem, and nothing else runs before the program's first
         * synchronous reads. So the store stays SEALED through the reconcile, and a
         * reconcile that cannot vouch for its rows — the listing failed, came back
         * short, or there is no supervisor to ask — does not open it. The kept store
         * is emptied instead and this launch boots exactly as a cold one does: the
         * rare failure costs a relaunch its speedup, never a stale byte.
         *
         * The previous process's own unacknowledged rows are the one thing the
         * reconcile cannot judge, since it keeps own rows whatever the listing says.
         * store.bind drops them before any of this runs.
         *
         * `takeBundle` hands over the module bundle and drops the module's own
         * reference to it. The parsed bundle is the largest allocation in the facet
         * before the program starts, so a cold boot releases it the moment it is
         * adopted, and a kept store that reconciles never adopts it at all. A cell
         * may be a getter that reads its text as it is taken (a node process's code
         * cells, read back from the module map); `moduleBytes`, when the launch
         * costed the bundle already, spares reading each twice.
         *
         * Returns the cursor to publish and, when the boot fell short of the whole
         * filesystem, why.
         */
        async boot(takeBundle, moduleCursor, supervisor, moduleBytes) {
            coherence.tables('boot');
            let failure = null;
            if (coherence.cursor() !== null) {
                let pass = null;
                try {
                    pass = await synchronize(supervisor);
                }
                catch (e) {
                    failure = messageOf(e);
                }
                if (pass && pass.cursor)
                    return { cursor: await catchUp(supervisor, pass.cursor), failure: null };
                failure = 'a kept store could not be reconciled ('
                    + (failure || fail(pass) || 'the listing vouched for nothing')
                    + '); it was emptied and this launch booted from its own snapshot';
            }
            // A store with no cursor holds nothing any incarnation can date.
            cells.clear();
            const bundle = takeBundle();
            // The module map is the program's code: it is held whole or the launch
            // fails. Spawn admitted it (N18); this is room for it now, asked for when
            // the store's cap does not already cover it.
            let bytes = moduleBytes;
            if (typeof bytes !== 'number') {
                bytes = 0;
                for (const path of Object.keys(bundle || {}))
                    bytes += residentCellCost(bundle[path]);
            }
            if (!(await admission.ensureRoom(bytes))) {
                throw Object.assign(new Error('ENOSPC: workspace storage is full: this process\'s modules (' + Math.ceil(bytes / 1048576)
                    + ' MiB) do not fit in what is left of the session\'s storage'), { code: 'ENOSPC' });
            }
            const adopted = adoptModuleBundle(bundle, moduleCursor);
            // The pass that just failed is not retried. The store now holds what a
            // cold launch whose fill failed holds, and its first ACQUIRE's delta
            // brings it current the same way.
            if (failure !== null)
                return { cursor: adopted, failure };
            let pass = null;
            try {
                pass = await synchronize(supervisor);
            }
            catch (e) {
                failure = messageOf(e);
            }
            if (pass && pass.cursor)
                return { cursor: await catchUp(supervisor, pass.cursor), failure };
            return { cursor: adopted, failure: failure || fail(pass) };
        },
        setPushRoots(roots) {
            pushRoots = (Array.isArray(roots) ? roots : []).map((r) => String(r).replace(/^\/+|\/+$/g, ''));
        },
        pushable,
        acquireOptions,
        applyAcquire,
        setPlan(paths) {
            plan = new Set(Array.isArray(paths) ? paths.map((p) => nsKey(p)) : []);
        },
        setManifests(given) {
            const files = given && typeof given === 'object' && given.files && typeof given.files === 'object'
                ? given.files : null;
            manifests = files === null ? null : new Map(Object.entries(files));
        },
        adoptModuleBundle,
        synchronize,
        /**
         * Refetch, after a delta the store applied without a listing, what it should
         * hold and does not: the paths the delta dropped and the launch's data plan.
         * The namespace (current as of that delta) gives each one's size and
         * revision, as a listing entry would.
         */
        async refillFromNamespace(supervisor, dropped) {
            const t = coherence.tables('refillFromNamespace');
            const cursor = coherence.cursor();
            if (cursor === null)
                return { requested: 0, filled: 0, failed: 0, bytes: 0 };
            const fetch = [];
            const seen = new Set();
            for (const path of [...dropped, ...plan]) {
                if (seen.has(path))
                    continue;
                seen.add(path);
                if (cells.has(path))
                    continue;
                const row = nsRowAt(t, path);
                if (row === undefined || row.kind !== NS_FILE)
                    continue;
                fetch.push({ path, size: row.size, rev: row.rev, epoch: rootOf(cursor).epoch, ckey: null, version: versionOf(row) });
            }
            return transport.fetchFiles(supervisor, fetch);
        },
        /**
         * The launch's last step before user code: the namespace must answer, since
         * every synchronous stat, exists and readdir reads it. A boot that left it
         * unready (its listing failed, came back short, or could not describe every
         * name) is repaired once more. Resolves to null when it answers, or to the
         * launch's failure, naming why; nothing is ever run on a namespace that
         * does not.
         */
        async requireNamespace(supervisor, bootFailure) {
            if (namespace.ready())
                return null;
            // What stopped the repair, else the boot: why the namespace still does not answer.
            let failure = bootFailure;
            try {
                const repaired = await synchronize(supervisor);
                failure = fail(repaired) || failure;
            }
            catch (e) {
                failure = messageOf(e);
            }
            if (namespace.ready())
                return null;
            return 'node: the process was not started: its view of the filesystem could not be listed ('
                + (failure || namespace.notReadyCause()) + ')';
        },
    };
}
/**
 * The file a namespace row names, as a read of an undated one (rev 0) checks
 * it (transport.ts WantedFile): its stat's identity and times, and no
 * revision, which the row keeps none of for a mount's file.
 */
function versionOf(row) {
    return { dev: row.dev, ino: row.ino, size: row.size, mtime: row.mtime, ctime: row.ctime, revision: row.rev };
}
