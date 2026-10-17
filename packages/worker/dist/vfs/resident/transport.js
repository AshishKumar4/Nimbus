/**
 * The store's reads of the session: whole listings a page at a time, one
 * directory's, one subtree's, an lstat walk down one path, and file bytes in
 * packed ranged batches. What boot, reconcile and a lazily listed namespace
 * fetch with (sync.ts, lazy.ts). Every bound here is the session's.
 */
import { FS_LIST_PAGE_LIMIT, FS_LIST_TREE_MAX_ENTRIES, FS_READ_BATCH_PATH_LIMIT, FS_READ_BATCH_REQUEST_BYTES, } from '@nimbus-sh/core/constants.js';
import { RESIDENT_ROW_BYTES, namespaceRowBytes, residentBytes } from './cell-cost.js';
import { nsDescribes, nsKey, nsSplit } from './namespace.js';
import { RESIDENT_CHUNK_BYTES } from '../facet-resident-limits.js';
import { RK_BINARY, RK_OWN_WRITE } from './tables.js';
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
export const messageOf = (e) => (e?.message) || String(e);
export function createTransport(coherence, admission, namespace, cells) {
    /**
     * Re-read the names beneath `dir` from the authority: a directory that just
     * became searchable, whose descendants no delta will ever name.
     */
    const relist = async (supervisor, dir) => {
        const t = coherence.tables('relist');
        if (!supervisor || typeof supervisor.fsList !== 'function') {
            namespace.markReady(t, false, 'the session cannot list its filesystem');
            return;
        }
        const prefix = dir + '/';
        const seen = [];
        let replaceBytes = 0;
        let incomingBytes = 0;
        if (admission.inHeap) {
            for (const row of t.nsKeys()) {
                const key = row.parent ? row.parent + '/' + row.name : row.name;
                if (!key.startsWith(prefix))
                    continue;
                replaceBytes += namespaceRowBytes(row.parent, row.name, t.nsGet(row.parent, row.name)?.target);
            }
        }
        let after = prefix;
        let done = false;
        for (let page = 0; page < MAX_LIST_PAGES && !done; page++) {
            let listed;
            try {
                listed = await supervisor.fsList(after, FS_LIST_PAGE_LIMIT);
            }
            catch (e) {
                namespace.markReady(t, false, 'a listing of /' + dir + ' failed (' + messageOf(e) + ')');
                return;
            }
            if (!listed || !Array.isArray(listed.entries)) {
                namespace.markReady(t, false, 'a listing of /' + dir + ' came back without entries');
                return;
            }
            for (const entry of listed.entries) {
                const k = nsKey(entry.path);
                if (!k.startsWith(prefix)) {
                    if (k > prefix) {
                        done = true;
                        break;
                    }
                    continue;
                }
                if (entry.stat) {
                    if (admission.inHeap && admission.cap !== null) {
                        const [parent, name] = nsSplit(k);
                        incomingBytes += namespaceRowBytes(parent, name, entry.linkTarget ?? entry.unlisted);
                        const refused = admission.namespaceRefusal(incomingBytes - replaceBytes);
                        if (refused !== null) {
                            namespace.markReady(t, false, refused);
                            return;
                        }
                    }
                    seen.push(entry);
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
        if (!seen.every((entry) => nsDescribes(entry.stat))) {
            namespace.markReady(t, false, 'a listing of /' + dir + ' named an entry without its stat');
            return;
        }
        // Exactly what the listing has under the directory: a name it no longer
        // shows (hidden now, or gone) leaves, one it shows is written.
        namespace.deleteTree(t, dir, false);
        for (const entry of seen)
            namespace.put(t, nsKey(entry.path), entry.stat, entry.rev, entry.linkTarget, entry.unlisted ?? null);
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
    const outdated = (t, path, rev) => {
        const [parent, name] = nsSplit(path);
        const listed = t.nsGet(parent, name);
        return listed !== undefined && Number(listed.rev) > rev;
    };
    const fetchFiles = async (supervisor, wantedFiles) => {
        // Content already held under another path, or wanted twice in this batch,
        // is fetched once: equal keys are equal bytes (the second copy is local).
        const t = coherence.tables('fetchFiles');
        const requested = wantedFiles.length;
        let copied = 0;
        const files = [];
        const later = [];
        const fetching = new Set();
        for (const file of wantedFiles) {
            if (file.ckey != null) {
                if (cells.copyByKey(t, file.path, file.ckey, file.rev)) {
                    copied++;
                    continue;
                }
                if (fetching.has(file.ckey)) {
                    later.push(file);
                    continue;
                }
                fetching.add(file.ckey);
            }
            files.push(file);
        }
        // One flat list of ranges across all files, so packing is a single pass and
        // a 25 MiB file and a 40-byte one are the same shape.
        const ranges = [];
        for (const file of files) {
            const parts = Math.max(1, Math.ceil(file.size / RESIDENT_CHUNK_BYTES));
            const version = file.rev === 0 ? file.version ?? file.stat ?? null : null;
            for (let part = 0; part < parts; part++) {
                const offset = part * RESIDENT_CHUNK_BYTES;
                ranges.push({
                    path: file.path,
                    rev: file.rev,
                    epoch: file.epoch,
                    version,
                    part,
                    parts,
                    offset,
                    length: Math.min(RESIDENT_CHUNK_BYTES, Math.max(0, file.size - offset)),
                    size: file.size,
                    ckey: file.ckey ?? null,
                });
            }
        }
        // Per-file landed-part counts, so a head row is written only once every
        // range of that file is in. See cells.putHead.
        const landed = new Map();
        let filled = 0, failed = 0, fetchedBytes = 0;
        const failedPaths = new Set();
        /** The revision each path is read at. */
        const revOf = new Map(ranges.map((range) => [range.path, range.rev]));
        for (let at = 0; at < ranges.length;) {
            const batch = [];
            let bytes = 0;
            while (at < ranges.length
                && batch.length < BATCH_PATHS
                && (batch.length === 0 || bytes + ranges[at].length <= BATCH_BYTES)) {
                bytes += ranges[at].length;
                batch.push(ranges[at]);
                at++;
            }
            // N18: room for the batch first; what the ledger will not admit is read
            // through the session instead of held.
            if (!(await admission.ensureRoom(bytes + batch.length * RESIDENT_ROW_BYTES))) {
                for (const r of batch)
                    failedPaths.add(r.path);
                continue;
            }
            let results;
            try {
                results = await supervisor.fsReadBatch(
                // A dated file at its revision; an undated one as its listing's stat named it.
                batch.map((r) => (r.version === null
                    ? { path: r.path, offset: r.offset, length: r.length, expectedEpoch: r.epoch, expectedRevision: r.rev }
                    : { path: r.path, offset: r.offset, length: r.length, expectedFile: fileVersionOf(r.version) })));
            }
            catch {
                for (const r of batch)
                    failedPaths.add(r.path);
                continue;
            }
            for (let i = 0; i < batch.length; i++) {
                const range = batch[i];
                const entry = results && results[i];
                if (!entry || entry.error) {
                    // A denial is a real answer and is stored as one, so a later read
                    // reports EACCES synchronously instead of missing. Anything else is a
                    // path this store will not hold, and a read of it falls through to
                    // exactly the miss it would have had before.
                    const code = entry?.error ? entry.error.code : undefined;
                    if (code === 'EACCES' && range.part === 0) {
                        cells.put(t, range.path, { error: 'EACCES' }, range.rev);
                        filled++;
                    }
                    else
                        failedPaths.add(range.path);
                    continue;
                }
                if (entry.bytes === null || entry.bytes === undefined) {
                    failedPaths.add(range.path);
                    continue;
                }
                const chunk = residentBytes(entry.bytes);
                if (chunk.byteLength !== range.length) {
                    failedPaths.add(range.path);
                    continue;
                }
                // Not a byte of it beneath a newer revision of the file (another fill's head and chunks).
                if (outdated(t, range.path, range.rev)) {
                    failedPaths.add(range.path);
                    continue;
                }
                fetchedBytes += chunk.byteLength;
                if (!cells.putChunk(t, range.path, range.part, chunk)) {
                    failedPaths.add(range.path);
                    continue;
                }
                const seen = (landed.get(range.path) || 0) + 1;
                landed.set(range.path, seen);
                if (seen === range.parts && !failedPaths.has(range.path)) {
                    cells.putHead(t, range.path, RK_BINARY, range.size, range.parts, range.rev, range.ckey);
                    filled++;
                }
            }
        }
        // A file whose ranges did not all land has chunk rows and no head, so it is
        // unreadable rather than short. Drop them so the slot does not carry bytes
        // nothing will ever serve.
        for (const path of failedPaths) {
            failed++;
            // A head at this read's revision or later (another fill, own bytes) is
            // not this read's to drop; an older one may sit over chunks this read
            // wrote, and goes with them.
            const held = t.fileRev(path);
            const rev = revOf.get(path);
            if (held !== undefined && (held === RK_OWN_WRITE || (rev !== undefined && held >= rev)))
                continue;
            t.chunkDelete(path);
            t.fileDelete(path);
        }
        for (const file of later) {
            if (!outdated(t, file.path, file.rev) && cells.copyByKey(t, file.path, file.ckey, file.rev))
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
        const entries = [];
        // Every name, whatever its kind: the namespace is built from these.
        const names = [];
        let namespaceBytes = 0;
        let after = null;
        let cursor = null;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const listed = await supervisor.fsList(after, FS_LIST_PAGE_LIMIT);
            if (!listed || !Array.isArray(listed.entries)) {
                throw new Error('Nimbus: fsList returned no page');
            }
            if (cursor === null) {
                cursor = { epoch: String(listed.epoch), rev: Number(listed.rev) };
            }
            else if (String(listed.epoch) !== cursor.epoch) {
                return { entries, names, cursor, complete: false, reason: 'the supervisor changed incarnation mid-enumeration' };
            }
            for (const entry of listed.entries) {
                if (entry.stat) {
                    if (admission.inHeap && admission.cap !== null) {
                        const key = nsKey(entry.path);
                        const [parent, name] = nsSplit(key);
                        if (key)
                            namespaceBytes += namespaceRowBytes(parent, name, entry.linkTarget ?? entry.unlisted);
                        const heap = coherence.heap;
                        const refused = admission.namespaceRefusal(namespaceBytes - (heap === null ? 0 : heap.nsBytes()));
                        if (refused !== null)
                            namespace.refuse(t, refused);
                    }
                    names.push(entry);
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
                const size = Number(entry.size);
                // The path's own last-mutation revision. It is what makes a held row
                // verifiable without fetching its bytes, and so what makes a poison
                // repairable rather than fatal — see synchronize.
                const rev = Number(entry.rev);
                if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(rev) || rev < 0) {
                    throw new Error("Nimbus: fsList returned unusable metadata for '" + path + "'");
                }
                // Its stat, for the bytes the store already has: who may read them (namespace.readable).
                entries.push({ path, size, rev, epoch: cursor.epoch, ckey: entry.contentKey == null ? null : String(entry.contentKey), stat: entry.stat ?? null });
            }
            if (listed.next === null || listed.next === undefined) {
                return { entries, names, namespaceBytes, cursor, complete: true, reason: null };
            }
            after = listed.next;
        }
        return { entries, names, cursor, complete: false, reason: 'the filesystem exceeded the enumeration page bound' };
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
        if (!supervisor || typeof supervisor.fsReadBatch !== 'function' || keys.length === 0)
            return false;
        const t = coherence.require();
        const batch = keys.slice(0, BATCH_PATHS - 2);
        const last = batch[batch.length - 1];
        const withContent = contentBytes > 0 && batch.length === keys.length;
        const requests = batch.map((k) => ({ path: '/' + k, lstat: true }));
        if (withContent)
            requests.push({ path: '/' + last, offset: 0, length: contentBytes }, { path: '/' + last, lstat: true });
        let answers;
        try {
            answers = await supervisor.fsReadBatch(requests);
        }
        catch {
            return false;
        }
        if (!Array.isArray(answers) || answers.length !== requests.length)
            return false;
        let reachedLast = false;
        for (let i = 0; i < batch.length; i++) {
            const answer = answers[i];
            if (!answer || answer.error || answer.stat === null || answer.stat === undefined || !nsDescribes(answer.stat))
                break;
            let target;
            if (answer.stat.type === 'symlink') {
                try {
                    target = await supervisor.readlink('/' + batch[i]);
                }
                catch {
                    break;
                }
                if (typeof target !== 'string')
                    break;
            }
            if (!namespace.tryPut(t, batch[i], answer.stat, Number(answer.stat.revision) || 0, target))
                return false;
            if (i === batch.length - 1)
                reachedLast = true;
            if (answer.stat.type !== 'directory')
                break;
        }
        if (withContent && reachedLast) {
            const before = answers[batch.length - 1].stat;
            const read = answers[batch.length];
            const after = answers[batch.length + 1];
            const bytes = read && !read.error && read.bytes ? residentBytes(read.bytes) : null;
            if (before.type === 'file' && bytes !== null && bytes.byteLength === Number(before.size)
                && after && !after.error && after.stat && after.stat.type === 'file'
                && Number(after.stat.ino) === Number(before.ino) && Number(after.stat.revision) === Number(before.revision)
                && await admission.ensureRoom(bytes.byteLength + RESIDENT_ROW_BYTES)) {
                // Whatever was held there is replaced whole, never left headless or with stray parts.
                t.fileDelete(last);
                t.chunkDelete(last);
                if (cells.putChunk(t, last, 0, bytes))
                    cells.putHead(t, last, RK_BINARY, bytes.byteLength, 1, Number(before.revision) || 0, null);
            }
        }
        return true;
    };
    /**
     * List the entries directly under `dir`: its names (readdir) and each one's
     * stat (an lstat batch), then each symlink's target. Two round trips for a
     * directory of any size up to the batch bound, where a stat per name would be
     * one each. A name that went between the two is not written; one that came is
     * reported by the next delta, since the store's cursor predates both.
     * Returns false when the directory cannot be listed (gone, not a directory,
     * not readable): the caller asks the authority instead.
     */
    const listDirectory = async (supervisor, dir) => {
        if (!supervisor || typeof supervisor.readdir !== 'function' || typeof supervisor.fsReadBatch !== 'function')
            return false;
        const t = coherence.require();
        let names;
        try {
            names = await supervisor.readdir('/' + dir);
        }
        catch {
            return false;
        }
        if (!Array.isArray(names))
            return false;
        const keys = names.map((entry) => (dir === '' ? '' : dir + '/') + String(entry.name));
        const stats = new Map();
        for (let i = 0; i < keys.length; i += BATCH_PATHS) {
            const batch = keys.slice(i, i + BATCH_PATHS);
            let answers;
            try {
                answers = await supervisor.fsReadBatch(batch.map((k) => ({ path: '/' + k, lstat: true })));
            }
            catch {
                return false;
            }
            if (!Array.isArray(answers) || answers.length !== batch.length)
                return false;
            for (let j = 0; j < batch.length; j++) {
                const answer = answers[j];
                if (!answer || answer.error)
                    return false;
                if (answer.stat === null || answer.stat === undefined)
                    continue;
                if (!nsDescribes(answer.stat))
                    return false;
                stats.set(batch[j], answer.stat);
            }
        }
        const targets = new Map();
        for (const [k, stat] of stats) {
            if (stat.type !== 'symlink')
                continue;
            let target;
            try {
                target = await supervisor.readlink('/' + k);
            }
            catch {
                return false;
            }
            if (typeof target !== 'string')
                return false;
            targets.set(k, target);
        }
        // Only what the directory holds now: a row for a name it no longer shows goes.
        for (const child of namespace.children(dir)) {
            const k = (dir === '' ? '' : dir + '/') + child.name;
            if (!stats.has(k))
                namespace.deleteTree(t, k, true);
        }
        for (const [k, stat] of stats) {
            if (!namespace.tryPut(t, k, stat, Number(stat.revision) || 0, targets.get(k)))
                return false;
        }
        namespace.markListed(dir);
        return true;
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
        if (!supervisor || typeof supervisor.fsListTree !== 'function')
            return false;
        const t = coherence.require();
        let tree;
        try {
            tree = await supervisor.fsListTree('/' + dir, FS_LIST_TREE_MAX_ENTRIES);
        }
        catch {
            return false;
        }
        if (!tree || !Array.isArray(tree.entries))
            return false;
        const listed = [dir];
        const written = new Set();
        for (const entry of tree.entries) {
            const k = nsKey(entry.path);
            if (!entry.stat || !nsDescribes(entry.stat))
                return false;
            if (!namespace.tryPut(t, k, entry.stat, entry.rev, entry.linkTarget, entry.unlisted ?? null))
                return false;
            written.add(k);
            if (entry.kind === 'directory' && !entry.unlisted)
                listed.push(k);
        }
        // A name the listing no longer shows under a directory it listed goes.
        for (const directory of listed) {
            for (const child of namespace.children(directory)) {
                const k = (directory === '' ? '' : directory + '/') + child.name;
                if (!written.has(k))
                    namespace.deleteTree(t, k, true);
            }
        }
        for (const directory of listed)
            namespace.markListed(directory);
        return true;
    };
    return { relist, fetchFiles, enumerate, lookupKeys, listDirectory, listSubtree };
}
/** The fields of a stat that name a file's version, alone, as the request carries them. */
function fileVersionOf(stat) {
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtime: stat.mtime, ctime: stat.ctime, revision: stat.revision };
}
