/**
 * removal-walk.ts — rm -r's walk: the one place its per-entry decisions are
 * made, for CompositeVFS's walk over any backend and for SqliteVFS's own
 * removal of a tree in which something may be refused.
 *
 * GNU rm -r's: every entry is stat'ed without following links and each
 * directory read, children before the directory holding them; each entry
 * is then removed (unlink, or rmdir for a directory). An entry whose removal
 * is refused stays, and so does every directory holding it; the walk carries
 * on past it. One that is gone when it is stat'ed, read or removed has
 * vanished, which is no failure: with `keepVanishedAncestors` the
 * directories holding it stay, as GNU leaves them, otherwise they go. A
 * directory that could not be read reports that refusal, not its rmdir's.
 * A directory the walk does not cross (a mount point, as GNU rm
 * --one-file-system keeps out of one) is neither read nor removed: it stays,
 * with what holds it, and is reported EBUSY.
 */
import { isVfsError, syscallError } from './vfs-error.js';
import { parentOf } from './path.js';
import { andThen, isPromise } from './vfs.js';
/** rm -r of `walk.rel` by `steps`, with its exact report (VfsRemoval). */
export function walkRemoval(steps, walk) {
    const { rel, at, keepVanishedAncestors } = walk;
    const order = [];
    const kept = new Set();
    const gone = new Set();
    const vanished = new Set();
    const failures = [];
    const keepWithAncestors = (r) => {
        for (let k = r;; k = parentOf(k)) {
            kept.add(k);
            if (k === rel || k === '/')
                break;
        }
    };
    const missing = (r) => {
        gone.add(r);
        vanished.add(r);
        if (keepVanishedAncestors && r !== rel)
            keepWithAncestors(parentOf(r));
    };
    const asError = (cause) => (cause instanceof Error ? cause : new Error(String(cause), { cause }));
    const errorOf = (r, syscall, cause) => {
        if (walk.passes(cause))
            throw cause;
        return syscallError(isVfsError(cause) ? cause.code : 'EIO', syscall, at(r), {
            detail: isVfsError(cause) ? cause.detail : String(cause), cause,
        });
    };
    const statFailed = (r, error) => {
        if (r === rel)
            throw error;
        if (error.code === 'ENOENT') {
            missing(r);
            return;
        }
        // FTS_NS: unlink can succeed even when lstat cannot answer.
        order.push({ rel: r, dir: false });
    };
    const visit = (r) => {
        let stat;
        try {
            stat = steps.lstat(r);
        }
        catch (cause) {
            statFailed(r, errorOf(r, 'lstat', asError(cause)));
            return undefined;
        }
        return isPromise(stat) ? stat.then((value) => entered(r, value), (cause) => statFailed(r, errorOf(r, 'lstat', asError(cause)))) : entered(r, stat);
    };
    const entered = (r, stat) => {
        if (stat === null) {
            if (r === rel)
                throw walk.missing();
            missing(r);
            return undefined;
        }
        const entry = { rel: r, dir: stat.type === 'directory' };
        if (stat.type !== 'directory') {
            order.push(entry);
            return undefined;
        }
        if (steps.crosses !== undefined && !steps.crosses(r)) {
            keepWithAncestors(r);
            // As the rmdir it is not attempted would be refused: the mount point is busy.
            failures.push({ path: at(r), error: syscallError('EBUSY', 'rmdir', at(r)) });
            return undefined;
        }
        const failed = (cause) => {
            const error = errorOf(r, 'scandir', asError(cause));
            if (error.code === 'ENOENT')
                missing(r);
            else {
                entry.unread = error;
                order.push(entry);
            }
        };
        let entries;
        try {
            entries = steps.readdir(r);
        }
        catch (cause) {
            failed(cause);
            return undefined;
        }
        const descend = (names) => names.reduce((chain, child) => andThen(chain, () => visit(r === '/' ? `/${child.name}` : `${r}/${child.name}`)), undefined);
        const visited = (names) => andThen(descend(names), () => { order.push(entry); });
        return isPromise(entries) ? entries.then(visited, failed) : visited(entries);
    };
    return andThen(visit(rel), () => andThen(order.reduce((chain, entry) => andThen(chain, () => {
        if (gone.has(entry.rel) || kept.has(entry.rel))
            return undefined;
        const fail = (cause) => {
            let error = errorOf(entry.rel, entry.dir ? 'rmdir' : 'unlink', asError(cause));
            if (error.code === 'ENOENT') {
                missing(entry.rel);
                return;
            }
            if (entry.unread !== undefined && ['ENOTEMPTY', 'EISDIR', 'ENOTDIR', 'EEXIST'].includes(error.code))
                error = entry.unread;
            keepWithAncestors(entry.rel);
            failures.push({ path: at(entry.rel), error });
        };
        const removed = () => { gone.add(entry.rel); };
        let out;
        try {
            out = steps.remove(entry.rel, entry.dir);
        }
        catch (cause) {
            fail(cause);
            return undefined;
        }
        if (isPromise(out))
            return out.then(removed, fail);
        removed();
        return undefined;
    }), undefined), () => {
        const removed = [...gone].filter((r) => r === rel || !gone.has(parentOf(r))).map(at).sort();
        return { removed, kept: [...kept].map(at).sort(), failures, ...(vanished.size === 0 ? {} : { vanished: [...vanished].map(at).sort() }) };
    }));
}
