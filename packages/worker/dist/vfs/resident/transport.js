/**
 * The store's reads of the session: whole listings a page at a time, one
 * directory's, one subtree's, an lstat walk down one path, and file bytes in
 * packed ranged batches. What boot, reconcile and a lazily listed namespace
 * fetch with (sync.ts, view.ts). Every bound here is the session's.
 */
import { FS_LIST_PAGE_LIMIT, FS_LIST_TREE_MAX_ENTRIES, FS_READ_BATCH_PATH_LIMIT, FS_READ_BATCH_REQUEST_BYTES, } from '@nimbus-sh/core/constants.js';
import { arrayCopy, arrayIsArray, Error, mathCeil, mathMax, mathMin, NumberOf, numberIsSafeInteger, objectHasOwn, ownField, reflectApply, reflectGet, SafeList, SafeMap, SafeSet, stringOf, stringStartsWith, typedArrayByteLength, TypeError, } from '@nimbus-sh/core/_shared/primordials.js';
import { RESIDENT_ROW_BYTES, namespaceRowBytes, residentBytes, residentCellCost } from './cell-cost.js';
import { nsDescribes, nsKey } from './namespace.js';
import { nsName, nsParent } from './namespace-lookup.js';
import { RESIDENT_CHUNK_BYTES } from '../facet-resident-limits.js';
import { RK_BINARY } from './tables.js';
/**
 * The `fsReadBatch` bounds, as the filler must respect them.
 *
 * These are not the store's to choose — they belong to the supervisor, and a
 * filler that guessed at them does not degrade gracefully: `_rpcFsReadBatch`
 * validates with zod and rejects the WHOLE call, so one over-packed batch
 * loses every path in it.
 */
const BATCH_PATHS = FS_READ_BATCH_PATH_LIMIT;
const BATCH_BYTES = FS_READ_BATCH_REQUEST_BYTES;
/**
 * Pages one enumeration may take before it gives up.
 *
 * A bound rather than an unbounded loop because `fsList` is a network call in
 * a boot path: a supervisor that never reported a null `next` would spin here
 * forever and the process would never start. At the page size above this
 * admits filesystems into the tens of millions of paths, so it bounds a defect
 * rather than a workload.
 */
const MAX_LIST_PAGES = 4096;
/** Relists of one directory a barrier tries, each overtaken by a later one's delta, before the namespace stops answering. */
const RELIST_ATTEMPTS = 3;
/** A record's own data field, retaining the type its contract gives it. */
function ownValue(record, key) {
    return objectHasOwn(record, key) ? record[key] : undefined;
}
/** An RPC stub exposes methods through its interceptor, not own data fields. */
function method(supervisor, name) {
    return reflectGet(supervisor, name);
}
// An exception's message wherever it is defined (a DOMException's, a class's, is inherited).
export const messageOf = (e) => {
    const message = e !== null && (typeof e === 'object' || typeof e === 'function') ? reflectGet(e, 'message') : undefined;
    return stringOf(message || e);
};
export function createTransport(coherence, admission, namespace, cells) {
    /**
     * Re-read the names beneath `dir` from the authority: a directory that just
     * became searchable, whose descendants no delta will ever name. A relist is
     * a learning: one a later barrier's delta overtook (a report at, above or
     * beneath `dir`) installs nothing and lists again, so often before the
     * namespace stops answering.
     */
    const relist = async (supervisor, dir) => {
        const t = coherence.tables('relist');
        const fsList = supervisor ? method(supervisor, 'fsList') : undefined;
        if (!supervisor || typeof fsList !== 'function') {
            namespace.markReady(t, false, 'the session cannot list its filesystem');
            return;
        }
        for (let attempt = 0; attempt < RELIST_ATTEMPTS; attempt++) {
            const learning = namespace.learning();
            try {
                const listed = await relistWith(learning, t, supervisor, fsList, dir);
                if (listed !== 'overtaken')
                    return;
            }
            finally {
                learning.end();
            }
        }
        namespace.markReady(t, false, 'a listing of /' + dir + ' was overtaken by every barrier since');
    };
    const relistWith = async (learning, t, supervisor, fsList, dir) => {
        const prefix = dir + '/';
        const seen = new SafeList();
        let replaceBytes = 0;
        let incomingBytes = 0;
        if (admission.inHeap) {
            const rows = t.nsKeys();
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const key = row.parent ? row.parent + '/' + row.name : row.name;
                if (!stringStartsWith(key, prefix))
                    continue;
                replaceBytes += namespaceRowBytes(row.parent, row.name, t.nsGet(row.parent, row.name)?.target);
            }
        }
        let after = prefix;
        let done = false;
        for (let page = 0; page < MAX_LIST_PAGES && !done; page++) {
            let listed;
            try {
                listed = await reflectApply(fsList, supervisor, [after, FS_LIST_PAGE_LIMIT]);
            }
            catch (e) {
                namespace.markReady(t, false, 'a listing of /' + dir + ' failed (' + messageOf(e) + ')');
                return;
            }
            if (!listed || !arrayIsArray(listed.entries)) {
                namespace.markReady(t, false, 'a listing of /' + dir + ' came back without entries');
                return;
            }
            for (let i = 0; i < listed.entries.length; i++) {
                const entry = listed.entries[i];
                const k = nsKey(entry.path);
                if (!stringStartsWith(k, prefix)) {
                    if (k > prefix) {
                        done = true;
                        break;
                    }
                    continue;
                }
                if (entry.stat) {
                    if (admission.inHeap && admission.cap !== null) {
                        incomingBytes += namespaceRowBytes(nsParent(k), nsName(k), ownValue(entry, 'linkTarget') ?? ownValue(entry, 'unlisted'));
                        const refused = admission.namespaceRefusal(incomingBytes - replaceBytes);
                        if (refused !== null) {
                            namespace.markReady(t, false, refused);
                            return;
                        }
                    }
                    seen[seen.length] = entry;
                }
            }
            if (listed.next === null || listed.next === undefined)
                done = true;
            else
                after = listed.next;
        }
        if (!done) {
            namespace.markReady(t, false, 'a listing of /' + dir + ' did not finish');
            return;
        }
        for (let i = 0; i < seen.length; i++) {
            if (!nsDescribes(seen[i].stat)) {
                namespace.markReady(t, false, 'a listing of /' + dir + ' named an entry without its stat');
                return;
            }
        }
        if (!learning.lists(dir))
            return 'overtaken';
        // Exactly what the listing has under the directory: a name it no longer
        // shows (hidden now, or gone) leaves, one it shows is written.
        namespace.deleteTree(t, dir, false);
        for (let i = 0; i < seen.length; i++) {
            const entry = seen[i];
            namespace.put(t, nsKey(entry.path), entry.stat, entry.rev, ownValue(entry, 'linkTarget'), ownValue(entry, 'unlisted') ?? null);
        }
        namespace.relisted(dir);
    };
    /**
     * Fetch these files from the authority and install them, each dated at the
     * revision the listing reported it at.
     *
     * THE BATCH BOUNDS ARE THE SUPERVISOR'S AND ARE NOT NEGOTIABLE HERE.
     * `_rpcFsReadBatch` validates with zod and rejects the WHOLE call, so an
     * over-packed batch loses every path in it rather than degrading. Three
     * separate bounds apply at once and the packing below respects all three:
     *
     *   paths per call      BATCH_PATHS            (FS_READ_BATCH_PATH_LIMIT)
     *   requested bytes     BATCH_BYTES            (FS_READ_BATCH_REQUEST_BYTES)
     *   bytes per range     RESIDENT_CHUNK_BYTES   (the single-value ceiling)
     *
     * Every file is split into RESIDENT_CHUNK_BYTES ranges — most files are one
     * short range — and the ranges are packed into calls. That makes the large
     * file the SAME path as the small one rather than a special case, and it means
     * no whole-file buffer is ever held: each range is written straight into its
     * own chunk row as it lands, and the head row follows only once every range of
     * that file has.
     *
     * A row is stamped with its OWN listed revision rather than with the global
     * cursor. Both are conservative — a write landing mid-fetch reports a revision
     * above the stamp, so the next ACQUIRE evicts and refetches, while stamping
     * newer than the bytes would keep a stale row forever — but the per-path
     * revision is the tighter of the two, and it is the one that survives a
     * reconcile: a row dated at the global cursor is indistinguishable from a row
     * whose path moved at that same revision.
     */
    /**
     * Whether the namespace holds a later revision of `path` than `rev`: bytes
     * read at `rev` are older than what a barrier admitted while the read was
     * in flight (read-ahead goes on beside the program's own calls), and are not
     * installed, or a later read would be served them by their length alone.
     */
    const outdated = (t, learning, path, rev) => {
        if (!learning.installs(path))
            return true;
        const listed = t.nsGet(nsParent(path), nsName(path));
        return listed !== undefined && NumberOf(listed.rev) > rev;
    };
    /** A fill is a learning too (namespace.learning): bytes a delta admitted while it was asked outdate are not installed. */
    const fetchFiles = async (supervisor, wantedFiles) => {
        const learning = namespace.learning();
        try {
            return await fetchWith(learning, supervisor, wantedFiles);
        }
        finally {
            learning.end();
        }
    };
    const fetchWith = async (learning, supervisor, wantedFiles) => {
        // Content already held under another path, or wanted twice in this batch,
        // is fetched once: equal keys are equal bytes (the second copy is local).
        const t = coherence.tables('fetchFiles');
        const requested = wantedFiles.length;
        let copied = 0;
        const files = new SafeList();
        const later = new SafeList();
        const fetching = new SafeSet();
        for (let i = 0; i < wantedFiles.length; i++) {
            const file = wantedFiles[i];
            const ckey = ownValue(file, 'ckey');
            if (ckey != null) {
                if (cells.copyByKey(t, file.path, ckey, file.rev)) {
                    copied++;
                    continue;
                }
                if (fetching.has(ckey)) {
                    later[later.length] = file;
                    continue;
                }
                fetching.add(ckey);
            }
            files[files.length] = file;
        }
        // One flat list of ranges across all files, so packing is a single pass and
        // a 25 MiB file and a 40-byte one are the same shape.
        const ranges = new SafeList();
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const parts = mathMax(1, mathCeil(file.size / RESIDENT_CHUNK_BYTES));
            const version = file.rev === 0 ? ownValue(file, 'version') ?? ownValue(file, 'stat') ?? null : null;
            const ckey = ownValue(file, 'ckey') ?? null;
            for (let part = 0; part < parts; part++) {
                const offset = part * RESIDENT_CHUNK_BYTES;
                ranges[ranges.length] = {
                    path: file.path,
                    rev: file.rev,
                    epoch: file.epoch,
                    version,
                    part,
                    parts,
                    offset,
                    length: mathMin(RESIDENT_CHUNK_BYTES, mathMax(0, file.size - offset)),
                    size: file.size,
                    ckey,
                };
            }
        }
        // Per-file landed-part counts, so a head row is written only once every
        // range of that file is in. See cells.publishFill.
        const landed = new SafeMap();
        let filled = 0, failed = 0, fetchedBytes = 0;
        const failedPaths = new SafeSet();
        /** This read's own, from before it is asked: the chunk rows it writes are its while nothing changes their heads (cells.beginFill). */
        const paths = new SafeList();
        for (let i = 0; i < files.length; i++)
            paths[paths.length] = files[i].path;
        const fill = cells.beginFill(paths);
        for (let at = 0; at < ranges.length;) {
            const batch = new SafeList();
            let bytes = 0;
            while (at < ranges.length
                && batch.length < BATCH_PATHS
                && (batch.length === 0 || bytes + ranges[at].length <= BATCH_BYTES)) {
                const range = ranges[at];
                bytes += range.length;
                batch[batch.length] = range;
                at++;
            }
            // N18: room for the batch first; what the ledger will not admit is read
            // through the session instead of held.
            if (!(await admission.ensureRoom(bytes + batch.length * RESIDENT_ROW_BYTES))) {
                for (let i = 0; i < batch.length; i++)
                    failedPaths.add(batch[i].path);
                continue;
            }
            let results;
            try {
                const fsReadBatch = method(supervisor, 'fsReadBatch');
                if (typeof fsReadBatch !== 'function')
                    throw new TypeError('supervisor.fsReadBatch is not a function');
                // A dated file at its revision; an undated one as its listing's stat named it.
                const requests = new SafeList();
                for (let i = 0; i < batch.length; i++) {
                    const r = batch[i];
                    requests[requests.length] = r.version === null
                        ? { path: r.path, offset: r.offset, length: r.length, expectedEpoch: r.epoch, expectedRevision: r.rev }
                        : { path: r.path, offset: r.offset, length: r.length, expectedFile: fileVersionOf(r.version) };
                }
                results = await reflectApply(fsReadBatch, supervisor, [arrayCopy(requests)]);
            }
            catch {
                for (let i = 0; i < batch.length; i++)
                    failedPaths.add(batch[i].path);
                continue;
            }
            for (let i = 0; i < batch.length; i++) {
                const range = batch[i];
                const entry = results && ownValue(results, i);
                const error = entry && ownValue(entry, 'error');
                if (!entry || error) {
                    // A denial is a real answer and is stored as one, so a later read
                    // reports EACCES synchronously instead of missing. Anything else is a
                    // path this store will not hold, and a read of it falls through to
                    // exactly the miss it would have had before.
                    const code = error ? ownField(error, 'code') : undefined;
                    if (code === 'EACCES' && range.part === 0) {
                        cells.put(t, range.path, { error: 'EACCES' }, range.rev);
                        filled++;
                    }
                    else
                        failedPaths.add(range.path);
                    continue;
                }
                const bytes = ownValue(entry, 'bytes');
                if (bytes === null || bytes === undefined) {
                    failedPaths.add(range.path);
                    continue;
                }
                const chunk = residentBytes(bytes);
                const chunkBytes = typedArrayByteLength(chunk);
                if (chunkBytes !== range.length) {
                    failedPaths.add(range.path);
                    continue;
                }
                // Not a byte of it beneath a newer revision of the file (another fill's head and chunks).
                if (outdated(t, learning, range.path, range.rev)) {
                    failedPaths.add(range.path);
                    continue;
                }
                fetchedBytes += chunkBytes;
                if (!cells.putChunk(t, range.path, range.part, chunk, fill)) {
                    failedPaths.add(range.path);
                    continue;
                }
                const seen = (landed.get(range.path) || 0) + 1;
                landed.set(range.path, seen);
                if (seen === range.parts && !failedPaths.has(range.path)) {
                    if (cells.publishFill(t, range.path, RK_BINARY, range.size, range.parts, range.rev, range.ckey, fill))
                        filled++;
                    else
                        failedPaths.add(range.path);
                }
            }
        }
        // A file whose ranges did not all land has chunk rows and no head, so it is
        // unreadable rather than short. The rows this read wrote go, with any head
        // they were written over, unless a later read, a fill or a write of the
        // process's took the path since: those are not this read's to drop.
        failedPaths.forEach((path) => {
            failed++;
            cells.abandonFill(t, path, fill);
        });
        for (let i = 0; i < later.length; i++) {
            const file = later[i];
            if (!outdated(t, learning, file.path, file.rev) && cells.copyByKey(t, file.path, ownValue(file, 'ckey'), file.rev))
                copied++;
            else
                failed++;
        }
        if (ranges.length > 0)
            await admission.reportSize();
        return {
            requested, filled: filled + copied, failed,
            bytes: fetchedBytes, ranges: ranges.length, copied,
        };
    };
    /**
     * Enumerate the whole filesystem, one page at a time.
     *
     * Every page is dated, and a page whose epoch differs from the first ABORTS
     * the listing. The supervisor was replaced mid-walk, so the pages already
     * collected describe a filesystem that no longer exists and the revision they
     * would be dated at is meaningless. Returning short is safe — the rows simply
     * are not there and the reads miss — while stitching the two halves together
     * would date one incarnation's bytes at another's clock.
     */
    const enumerate = async (supervisor) => {
        const t = coherence.tables('enumerate');
        const entries = new SafeList();
        // Every name, whatever its kind: the namespace is built from these.
        const names = new SafeList();
        let namespaceBytes = 0;
        let after = null;
        let cursor = null;
        const fsList = method(supervisor, 'fsList');
        if (typeof fsList !== 'function')
            throw new TypeError('supervisor.fsList is not a function');
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const listed = await reflectApply(fsList, supervisor, [after, FS_LIST_PAGE_LIMIT]);
            if (!listed || !arrayIsArray(listed.entries)) {
                throw new Error('Nimbus: fsList returned no page');
            }
            if (cursor === null) {
                cursor = { epoch: stringOf(listed.epoch), rev: NumberOf(listed.rev) };
            }
            else if (stringOf(listed.epoch) !== cursor.epoch) {
                return { entries: arrayCopy(entries), names: arrayCopy(names), cursor, complete: false, reason: 'the supervisor changed incarnation mid-enumeration' };
            }
            for (let i = 0; i < listed.entries.length; i++) {
                const entry = listed.entries[i];
                if (entry.stat) {
                    if (admission.inHeap && admission.cap !== null) {
                        const key = nsKey(entry.path);
                        if (key)
                            namespaceBytes += namespaceRowBytes(nsParent(key), nsName(key), ownValue(entry, 'linkTarget') ?? ownValue(entry, 'unlisted'));
                        const heap = coherence.heap;
                        const refused = admission.namespaceRefusal(namespaceBytes - (heap === null ? 0 : heap.nsBytes()));
                        if (refused !== null)
                            namespace.refuse(t, refused);
                    }
                    names[names.length] = entry;
                }
                // Directories carry no content, and a symlink's size is its TARGET's
                // length rather than the resolved file's — reading one by that size
                // would store a truncated file and call it whole. Content is fetched
                // by the path a symlink resolves to.
                if (entry.kind !== 'file')
                    continue;
                const path = nsKey(entry.path);
                if (!path)
                    continue;
                const size = NumberOf(entry.size);
                // The path's own last-mutation revision. It is what makes a held row
                // verifiable without fetching its bytes, and so what makes a poison
                // repairable rather than fatal — see synchronize.
                const rev = NumberOf(entry.rev);
                if (!numberIsSafeInteger(size) || size < 0 || !numberIsSafeInteger(rev) || rev < 0) {
                    throw new Error("Nimbus: fsList returned unusable metadata for '" + path + "'");
                }
                // Its stat, for the bytes the store already has: who may read them (namespace.readable).
                const contentKey = ownValue(entry, 'contentKey');
                entries[entries.length] = { path, size, rev, epoch: cursor.epoch, ckey: contentKey == null ? null : stringOf(contentKey), stat: entry.stat ?? null };
            }
            if (listed.next === null || listed.next === undefined) {
                return { entries: arrayCopy(entries), names: arrayCopy(names), namespaceBytes, cursor, complete: true, reason: null };
            }
            after = listed.next;
        }
        return { entries: arrayCopy(entries), names: arrayCopy(names), cursor, complete: false, reason: 'the filesystem exceeded the enumeration page bound' };
    };
    /**
     * Learn the names along one path in one round trip: an lstat of each key, in
     * order from the shallowest. A path ten directories deep costs one batch
     * rather than a listing of each directory on the way. A key below a symlink
     * names what the session reached THROUGH the link, which is not that key's
     * row, so nothing past the first link (or the first missing name) is written:
     * the walk follows the link and asks again. A missing name is not recorded as
     * absent; only a listed directory says what is not in it.
     *
     * With `contentBytes`, the same trip reads the last key's bytes and lstats it
     * again: a program that stats a file opens it next (a compiler's header
     * search, an interpreter's import), and a small file then costs nothing more.
     * The bytes are kept only when both lstats show the same file at the same
     * revision, so no write came between them and the read, and only when they
     * are all of it.
     */
    const lookupKeys = async (supervisor, keys, contentBytes) => {
        const fsReadBatch = supervisor ? method(supervisor, 'fsReadBatch') : undefined;
        if (!supervisor || typeof fsReadBatch !== 'function' || keys.length === 0)
            return false;
        const t = coherence.require();
        const batch = new SafeList();
        for (let i = 0, end = mathMin(keys.length, BATCH_PATHS - 2); i < end; i++)
            batch[batch.length] = keys[i];
        const last = batch[batch.length - 1];
        const withContent = contentBytes > 0 && batch.length === keys.length;
        const requests = new SafeList();
        for (let i = 0; i < batch.length; i++)
            requests[requests.length] = { path: '/' + batch[i], lstat: true };
        if (withContent) {
            requests[requests.length] = { path: '/' + last, offset: 0, length: contentBytes };
            requests[requests.length] = { path: '/' + last, lstat: true };
        }
        const learning = namespace.learning();
        try {
            let answers;
            try {
                answers = await reflectApply(fsReadBatch, supervisor, [arrayCopy(requests)]);
            }
            catch {
                return false;
            }
            if (!arrayIsArray(answers) || answers.length !== requests.length)
                return false;
            let reachedLast = false;
            for (let i = 0; i < batch.length; i++) {
                const answer = ownValue(answers, i);
                const stat = answer && ownValue(answer, 'stat');
                if (!answer || ownValue(answer, 'error') || stat === null || stat === undefined || !nsDescribes(stat))
                    break;
                let target;
                if (stat.type === 'symlink') {
                    try {
                        const readlink = method(supervisor, 'readlink');
                        if (typeof readlink !== 'function')
                            break;
                        target = await reflectApply(readlink, supervisor, ['/' + batch[i]]);
                    }
                    catch {
                        break;
                    }
                    if (typeof target !== 'string')
                        break;
                }
                if (!learning.installs(batch[i]) || !namespace.learn(t, batch[i], stat, NumberOf(stat.revision) || 0, target))
                    return false;
                if (i === batch.length - 1)
                    reachedLast = true;
                if (stat.type !== 'directory')
                    break;
            }
            if (withContent && reachedLast) {
                const lastAnswer = ownValue(answers, batch.length - 1);
                const before = lastAnswer && ownValue(lastAnswer, 'stat');
                const read = ownValue(answers, batch.length);
                const after = ownValue(answers, batch.length + 1);
                const content = read && !ownValue(read, 'error') && ownValue(read, 'bytes');
                const bytes = content ? residentBytes(content) : null;
                const size = bytes === null ? 0 : typedArrayByteLength(bytes);
                const afterStat = after && !ownValue(after, 'error') ? ownValue(after, 'stat') : null;
                if (before && before.type === 'file' && bytes !== null && size === NumberOf(before.size)
                    && afterStat && afterStat.type === 'file'
                    && NumberOf(afterStat.ino) === NumberOf(before.ino) && NumberOf(afterStat.revision) === NumberOf(before.revision)
                    && await admission.ensureRoom(residentCellCost(bytes)) && learning.installs(last)) {
                    // As a read's bytes: dating what is held already, replacing the rest whole.
                    cells.fill(last, bytes, NumberOf(before.revision) || 0);
                }
            }
            return true;
        }
        finally {
            learning.end();
        }
    };
    /**
     * List the entries directly under `dir`: its names (readdir) and each one's
     * stat (an lstat batch), then each symlink's target. Two round trips for a
     * directory of any size up to the batch bound, where a stat per name would be
     * one each. A name that went between the two leaves a listing the directory
     * never held, and nothing is written; one that came is reported by the next
     * delta, since the store's cursor predates both.
     * Returns false when the directory cannot be listed (gone, not a directory,
     * not readable): the caller asks the authority instead.
     */
    const listDirectory = async (supervisor, dir) => {
        const readdir = supervisor ? method(supervisor, 'readdir') : undefined;
        const fsReadBatch = supervisor ? method(supervisor, 'fsReadBatch') : undefined;
        if (!supervisor || typeof readdir !== 'function' || typeof fsReadBatch !== 'function')
            return false;
        const t = coherence.require();
        const learning = namespace.learning();
        try {
            let names;
            try {
                names = await reflectApply(readdir, supervisor, ['/' + dir]);
            }
            catch {
                return false;
            }
            if (!arrayIsArray(names))
                return false;
            const keys = new SafeList();
            for (let i = 0; i < names.length; i++)
                keys[keys.length] = (dir === '' ? '' : dir + '/') + stringOf(names[i].name);
            const stats = new SafeMap();
            for (let i = 0; i < keys.length; i += BATCH_PATHS) {
                const batch = new SafeList();
                const requests = new SafeList();
                for (let j = i, end = mathMin(keys.length, i + BATCH_PATHS); j < end; j++) {
                    batch[batch.length] = keys[j];
                    requests[requests.length] = { path: '/' + keys[j], lstat: true };
                }
                let answers;
                try {
                    answers = await reflectApply(fsReadBatch, supervisor, [arrayCopy(requests)]);
                }
                catch {
                    return false;
                }
                if (!arrayIsArray(answers) || answers.length !== batch.length)
                    return false;
                for (let j = 0; j < batch.length; j++) {
                    const answer = ownValue(answers, j);
                    if (!answer || ownValue(answer, 'error'))
                        return false;
                    const stat = ownValue(answer, 'stat');
                    if (stat === null || stat === undefined || !nsDescribes(stat))
                        return false;
                    stats.set(batch[j], stat);
                }
            }
            const statKeys = new SafeList();
            stats.forEach((_stat, k) => { statKeys[statKeys.length] = k; });
            const targets = new SafeMap();
            for (let i = 0; i < statKeys.length; i++) {
                const k = statKeys[i];
                const stat = stats.get(k);
                if (stat === undefined || stat.type !== 'symlink')
                    continue;
                let target;
                try {
                    const readlink = method(supervisor, 'readlink');
                    if (typeof readlink !== 'function')
                        return false;
                    target = await reflectApply(readlink, supervisor, ['/' + k]);
                }
                catch {
                    return false;
                }
                if (typeof target !== 'string')
                    return false;
                targets.set(k, target);
            }
            if (!learning.lists(dir))
                return false;
            // Only what the directory holds now: a row for a name it no longer shows goes.
            const children = namespace.children(dir);
            for (let i = 0; i < children.length; i++) {
                const child = children[i];
                const k = (dir === '' ? '' : dir + '/') + child.name;
                if (!stats.has(k))
                    namespace.deleteTree(t, k, true);
            }
            for (let i = 0; i < statKeys.length; i++) {
                const k = statKeys[i];
                const stat = stats.get(k);
                if (stat !== undefined && !namespace.learn(t, k, stat, NumberOf(stat.revision) || 0, targets.get(k)))
                    return false;
            }
            namespace.markListed(dir);
            return true;
        }
        finally {
            learning.end();
        }
    };
    /**
     * List everything beneath `dir` in one answer (fsListTree): what a walker
     * of the tree (git status, a build, an interpreter's startup) is about to
     * look at, in one round trip instead of two per directory, every entry
     * current at one revision. A subtree larger than the listing's bound is
     * refused there (E2BIG), and listed one directory at a time instead.
     * True when `dir` was listed whole.
     */
    const listSubtree = async (supervisor, dir) => {
        const fsListTree = supervisor ? method(supervisor, 'fsListTree') : undefined;
        if (!supervisor || typeof fsListTree !== 'function')
            return false;
        const t = coherence.require();
        const learning = namespace.learning();
        try {
            let tree;
            try {
                tree = await reflectApply(fsListTree, supervisor, ['/' + dir, FS_LIST_TREE_MAX_ENTRIES]);
            }
            catch {
                return false;
            }
            if (!tree || !arrayIsArray(tree.entries) || !learning.lists(dir))
                return false;
            const listed = new SafeList();
            listed[listed.length] = dir;
            const written = new SafeSet();
            for (let i = 0; i < tree.entries.length; i++) {
                const entry = tree.entries[i];
                const k = nsKey(entry.path);
                if (!entry.stat || !nsDescribes(entry.stat))
                    return false;
                const unlisted = ownValue(entry, 'unlisted');
                if (!namespace.tryPut(t, k, entry.stat, entry.rev, ownValue(entry, 'linkTarget'), unlisted ?? null))
                    return false;
                written.add(k);
                if (entry.kind === 'directory' && !unlisted)
                    listed[listed.length] = k;
            }
            // A name the listing no longer shows under a directory it listed goes.
            for (let i = 0; i < listed.length; i++) {
                const directory = listed[i];
                const children = namespace.children(directory);
                for (let j = 0; j < children.length; j++) {
                    const child = children[j];
                    const k = (directory === '' ? '' : directory + '/') + child.name;
                    if (!written.has(k))
                        namespace.deleteTree(t, k, true);
                }
            }
            for (let i = 0; i < listed.length; i++)
                namespace.markListed(listed[i]);
            return true;
        }
        finally {
            learning.end();
        }
    };
    return { relist, fetchFiles, enumerate, lookupKeys, listDirectory, listSubtree };
}
/** The fields of a stat that name a file's version, alone, as the request carries them. */
function fileVersionOf(stat) {
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtime, ctime: stat.ctime, revision: stat.revision };
}
