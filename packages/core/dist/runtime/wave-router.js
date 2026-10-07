/**
 * The namespace as every wave's router (SqliteVFS.setWaveRouter). A W7 wave
 * is streamed to the session's SQLite filesystem, whoever sends it (a
 * process's binding, or a command holding the engine), and each of its
 * records lands where the namespace puts a mutation of that name: its
 * directory resolved by the mutations' own lookup (CompositeVFS
 * .mutationRoute, links followed into mounts), and the record applied on a
 * mount by the namespace's own operations, so a mount's guard, read-only
 * flag and refusals are the wave's as they are a single call's.
 *
 * On a mount, a record is applied as an upsert is, by the operations a
 * program would use, each refusal before anything is lost:
 *   - a directory: mkdir -p, a directory already there kept;
 *   - a file: written to a staged name in its directory chunk by chunk as
 *     the wave delivers them (each chunk's credit released once written),
 *     then renamed over its name; on a backend that cannot write a range,
 *     taken whole up to HELD_FILE_BYTES, ENOTSUP past it;
 *   - a link: made at a staged name, then renamed over its name, so a
 *     backend that cannot make it refuses before the old entry goes;
 *   - a removal: rm -r, refused (EIO, naming what stayed) when it kept or
 *     failed to remove anything.
 */
import { VfsError } from '../vfs/vfs-error.js';
/**
 * The most a wave holds of one file for a mount that cannot write in place:
 * half the session's shared write credit, so a held file never starves the
 * wave of the credit its next chunk needs.
 */
export const HELD_FILE_BYTES = 4 * 1024 * 1024;
export function namespaceWaveRouter(namespace, credential) {
    const view = (cred, guard) => {
        const as = namespace.as(credential(cred));
        return guard === undefined ? as : as.scoped(guard);
    };
    return {
        resolveDirectory(path, cred, signal) {
            const ns = view(cred);
            const join = (resolved, missing) => (missing === '' ? resolved : `${resolved === '/' ? '' : resolved}/${missing}`);
            // The nearest ancestor that resolves, the rest kept as named; synchronous while the lookup is.
            const attempt = (at, missing) => {
                signal?.throwIfAborted();
                const retry = (error) => {
                    const code = error.code;
                    if ((code !== 'ENOENT' && code !== 'ENOTDIR') || at === '/')
                        throw error;
                    const cut = at.lastIndexOf('/');
                    return attempt(at.slice(0, cut) || '/', missing === '' ? at.slice(cut + 1) : `${at.slice(cut + 1)}/${missing}`);
                };
                let route;
                try {
                    route = ns.mutationRoute(at, { follow: true });
                }
                catch (error) {
                    return retry(error);
                }
                return route instanceof Promise ? route.then((resolved) => join(resolved.path, missing), retry) : join(route.path, missing);
            };
            return attempt(path, '');
        },
        placement(path) {
            const point = namespace.mountOf(path);
            if (point !== '/')
                return point;
            // A directory above a mount point is the namespace's, though on the root.
            return namespace.composes(path) ? point : null;
        },
        async apply(record, cred, guard) {
            // Guarded: every call to the backend. Cleanup of a staged name is not: it is the wave's own.
            return applyRecord(view(cred, guard), view(cred), record);
        },
    };
}
async function applyRecord(ns, cleanup, record) {
    switch (record.type) {
        case 'directory':
            await ns.mkdir(record.path, { recursive: true, mode: record.mode });
            return null;
        case 'delete': {
            if ((await ns.stat(record.path, { follow: false })) === null)
                return null;
            const removal = await ns.removeRecursive(record.path);
            if (removal.kept.length > 0 || removal.failures.length > 0) {
                const first = removal.failures[0];
                const code = first?.error.code ?? 'EIO';
                throw new VfsError(code, `rm -r removed ${removal.removed.length}, kept ${removal.kept.length}${removal.kept.length > 0 ? ` (${removal.kept.slice(0, 3).join(', ')})` : ''}, failed ${removal.failures.length}${first ? ` (${first.path}: ${first.error.message})` : ''}`, record.path);
            }
            return null;
        }
        case 'symlink': {
            const staged = stagedName(record.path);
            await ns.symlink(record.target, staged);
            try {
                await ns.rename(staged, record.path);
            }
            catch (error) {
                await cleanup.unlink(staged).catch(() => { });
                throw error;
            }
            return statOf(await ns.stat(record.path, { follow: false }));
        }
        case 'file':
            await spool(ns, cleanup, record);
            return statOf(await ns.stat(record.path, { follow: false }));
        case 'call': {
            // The call itself, as the namespace makes it: its own refusals (EEXIST, ENOTEMPTY, …).
            const call = record.call;
            if (call.call === 'mkdir')
                await ns.mkdir(call.path, { mode: call.mode });
            else if (call.call === 'unlink')
                await ns.unlink(call.path);
            else if (call.call === 'rmdir')
                await ns.rmdir(call.path);
            else
                await ns.symlink(call.target, call.path);
            return null;
        }
        case 'data-call': {
            // A writeFile or appendFile is the namespace's call with the whole bytes.
            const bytes = await gathered(record);
            if (record.call === 'appendFile') {
                const prior = await ns.stat(record.path);
                if (prior === null)
                    await ns.writeFile(record.path, bytes, { mode: record.mode });
                else
                    await ns.writeRange(record.path, prior.size, bytes);
            }
            else {
                await ns.writeFile(record.path, bytes, { mode: record.mode });
            }
            return statOf(await ns.stat(record.path));
        }
    }
}
/** A call's bytes whole, up to HELD_FILE_BYTES; each chunk's credit released once copied. */
async function gathered(record) {
    const iterator = record.chunks[Symbol.asyncIterator]();
    if (record.size > HELD_FILE_BYTES) {
        await drainIterator(iterator).catch(() => { });
        throw new VfsError('ENOTSUP', `a process's ${record.call} to a mount carries at most ${HELD_FILE_BYTES} bytes in one call; this one is ${record.size}`, record.path);
    }
    const bytes = new Uint8Array(record.size);
    let at = 0;
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        bytes.set(next.value.data, at);
        at += next.value.data.byteLength;
        next.value.release();
    }
    return bytes;
}
/**
 * Write a file at a staged name chunk by chunk, each chunk's credit
 * released once written, then rename it over its name. A backend that
 * cannot write a range (ENOTSUP at the first one) takes the file whole
 * instead, up to HELD_FILE_BYTES.
 */
async function spool(ns, cleanup, record) {
    const chunks = record.chunks[Symbol.asyncIterator]();
    const first = await chunks.next();
    if (first.done) {
        await ns.writeFile(record.path, new Uint8Array(0), { mode: record.mode });
        return;
    }
    const staged = stagedName(record.path);
    let made = false;
    let pending = first.value;
    try {
        await ns.writeFile(staged, new Uint8Array(0), { mode: record.mode });
        made = true;
        let offset = 0;
        while (pending !== null) {
            const chunk = pending;
            try {
                await ns.writeRange(staged, offset, chunk.data);
            }
            catch (error) {
                if (offset !== 0 || error.code !== 'ENOTSUP')
                    throw error;
                // This backend takes a file whole: what has arrived, then the rest.
                await cleanup.unlink(staged).catch(() => { });
                made = false;
                pending = null;
                await holdWhole(ns, record, [chunk], chunks);
                return;
            }
            offset += chunk.data.byteLength;
            chunk.release();
            const next = await chunks.next();
            pending = next.done ? null : next.value;
        }
        await ns.rename(staged, record.path);
    }
    catch (error) {
        pending?.release();
        if (made)
            await cleanup.unlink(staged).catch(() => { });
        // What the wave hands over after the failure goes back to it as it comes.
        await drainIterator(chunks).catch(() => { });
        throw error;
    }
}
/** Take a file whole (its chunks so far in `held`, the rest from `rest`), up to HELD_FILE_BYTES. */
async function holdWhole(ns, record, held, rest) {
    try {
        if (record.size > HELD_FILE_BYTES) {
            throw new VfsError('ENOTSUP', `a wave's file goes to a mount that cannot write in place whole, up to ${HELD_FILE_BYTES} bytes; this one is ${record.size}`, record.path);
        }
        for (let next = await rest.next(); !next.done; next = await rest.next())
            held.push(next.value);
        const bytes = new Uint8Array(record.size);
        let at = 0;
        for (const chunk of held) {
            bytes.set(chunk.data, at);
            at += chunk.data.byteLength;
        }
        await ns.writeFile(record.path, bytes, { mode: record.mode });
    }
    finally {
        for (const chunk of held.splice(0))
            chunk.release();
    }
}
async function drainIterator(chunks) {
    for (let next = await chunks.next(); !next.done; next = await chunks.next())
        next.value.release();
}
/** A name beside `path` in its directory that no program names. */
function stagedName(path) {
    const cut = path.lastIndexOf('/');
    return `${path.slice(0, cut)}/.${path.slice(cut + 1)}.nimbus-wave-${crypto.randomUUID().slice(0, 8)}`;
}
function statOf(stat) {
    if (stat === null)
        return null;
    return {
        ino: stat.ino ?? 0,
        mode: stat.mode ?? 0,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs ?? stat.mtimeMs,
        uid: stat.uid ?? 0,
        gid: stat.gid ?? 0,
        dev: stat.dev ?? 0,
    };
}
