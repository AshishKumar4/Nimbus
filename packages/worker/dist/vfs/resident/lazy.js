/**
 * A namespace listed on demand, for a process whose calls can wait (a WASI
 * guest, parked under JSPI): it starts with no names at the authority's
 * cursor and lists a directory the first time a lookup needs one of its
 * entries (namespace.ts), and its barrier starts it again from nothing when an
 * answer cannot be applied. `namespaceView` is the store as the WASI
 * filesystem adapter reads it.
 */
import { nsRowAt } from './namespace.js';
import { NS_DIR, NS_LINK, RK_OWN_WRITE } from './tables.js';
/** The most a lookup reads of the file it ends at, so the open that follows a stat costs no trip of its own. */
const LOOKUP_CONTENT_BYTES = 256 * 1024;
export function createLazy(coherence, admission, namespace, cells, transport, sync, pages) {
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
     * The ACQUIRE barrier of a lazily listed namespace, taken where input from
     * outside the process enters it (the runtime decides where; see the core
     * README's process model). An answer is applied as every barrier applies one
     * (sync.applyAcquire). One that cannot be — a poison, a delta without
     * stats, no answer — dates nothing the store holds, and the namespace starts
     * again from nothing at the authority's cursor: names are listed again on
     * demand, never served from a state the cursor has left.
     */
    const lazyBarrier = async (supervisor) => {
        const t = coherence.tables('lazyBarrier');
        const cursor = coherence.cursor();
        let answer = null;
        if (cursor !== null) {
            try {
                answer = await supervisor.fsAcquire(cursor.epoch, cursor.rev, { namespace: true });
            }
            catch {
                answer = null;
            }
        }
        if (answer && typeof answer.epoch === 'string' && typeof answer.rev === 'number') {
            if (!answer.poison) {
                await sync.applyAcquire(supervisor, answer);
                if (namespace.ready())
                    return true;
                beginLazy(t, coherence.cursor());
                return true;
            }
            beginLazy(t, { epoch: answer.epoch, rev: answer.rev });
            return true;
        }
        return bootLazy(supervisor);
    };
    return {
        bootLazy,
        /**
         * The store as a WASI process's filesystem adapter reads it (core
         * runtime/wasi/resident-filesystem.ts, ResidentNamespace): names as lstats,
         * listed on demand, file bytes held or fetched, and the barrier. `device` is
         * the session's SQLite device, the only one the adapter answers for.
         */
        namespaceView(supervisor, device, cred) {
            namespace.setCred(cred);
            const encoder = new TextEncoder();
            const typeOf = (kind) => (kind === NS_DIR ? 'directory' : kind === NS_LINK ? 'symlink' : 'file');
            const view = {
                device: Number(device),
                cred: { uid: Number(cred.uid), gid: Number(cred.gid), groups: (cred.groups || []).map(Number) },
                ready: () => namespace.lazy && namespace.ready(),
                entry(k) {
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
                barrier: () => lazyBarrier(supervisor),
                cursor: () => coherence.cursor(),
                // An ACQUIRE answer the caller took itself, applied as the barrier applies one.
                async admit(answer) {
                    if (!answer || typeof answer.epoch !== 'string' || typeof answer.rev !== 'number')
                        return false;
                    const before = coherence.cursor();
                    if (before && answer.epoch === before.epoch && answer.rev < before.rev)
                        return false;
                    await sync.applyAcquire(supervisor, answer);
                    if (!answer.poison && namespace.ready())
                        return true;
                    beginLazy(coherence.tables('admit'), { epoch: answer.epoch, rev: answer.rev });
                    return false;
                },
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
