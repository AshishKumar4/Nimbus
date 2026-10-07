/**
 * The namespace as every wave's router (SqliteVFS.setWaveRouter). A W7 wave
 * is streamed to the session's SQLite filesystem, whoever sends it (a
 * process's binding, or a command holding the engine), and each of its
 * records lands where the namespace puts a mutation of that name: its
 * directory resolved by the mutations' own lookup (CompositeVFS
 * .mutationRoute, links followed into mounts), and the name placed by the
 * mount table. A record placed on a mount is applied there by the
 * namespace's own operations, so a mount's guard, read-only flag and
 * refusals are the record's as they are a single call's.
 *
 * A routed record behaves as the single operations a program would make on
 * that mount, at the place the lookup resolved, re-resolved nowhere:
 *   - a directory: mkdir -p, a directory already there kept;
 *   - a file: writeFile with its first chunk (truncating it, following a
 *     link at its name, keeping an existing file's mode, owner and inode, as
 *     open(O_TRUNC) does), then each further chunk written at its offset
 *     into that same file as the wave delivers it, its credit released once
 *     written; a backend that writes no ranges takes the file whole instead,
 *     up to HELD_FILE_BYTES, ENOTSUP past it;
 *   - a link: made at a staged name beside it, then renamed over it (as
 *     ln -sf does), so a backend that cannot make it refuses before the old
 *     entry goes;
 *   - a removal: rm -r, refused (naming what stayed) when it kept or failed
 *     to remove anything.
 * Every call of a record first checks that its directory still resolves to
 * where the record was placed, and a file's further chunks that its name is
 * still the inode the first chunk wrote: one that moved refuses the record
 * (ESTALE) rather than writing elsewhere.
 *
 * A staged link is named `.<name>.nimbus-wave`, beside its name. One a
 * crash left behind is removed by the next wave that makes a link of that
 * name, or by any wave making a link in that directory once it is older
 * than STAGED_LINK_STALE_MS.
 */
import { VfsError } from '../vfs/vfs-error.js';
/**
 * The most a wave holds of one file for a mount that cannot write ranges:
 * half the session's shared write credit, so a held file never starves the
 * wave of the credit its next chunk needs.
 */
export const HELD_FILE_BYTES = 4 * 1024 * 1024;
/** The suffix of a link staged beside its name: `.<name>${STAGED_LINK_SUFFIX}`. */
export const STAGED_LINK_SUFFIX = '.nimbus-wave';
/** A staged link this old is a crash's leftover: a live one is renamed within the record. */
export const STAGED_LINK_STALE_MS = 60_000;
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
            const ns = view(cred, guard);
            // Cleanup of a staged name is the record's own, unguarded.
            const cleanup = view(cred);
            return applyRecord(ns, cleanup, record, pinOf(ns, parentOf(record.path)));
        },
    };
}
function parentOf(path) {
    return path.slice(0, path.lastIndexOf('/')) || '/';
}
function nameOf(path) {
    return path.slice(path.lastIndexOf('/') + 1);
}
/**
 * The record's directory, pinned: `check` refuses (ESTALE) when it no
 * longer resolves to `dir`, the place the record was given. Synchronous
 * while the lookup is, so the call it precedes is made in the same turn.
 */
function pinOf(ns, dir) {
    const moved = () => {
        throw new VfsError('ESTALE', 'the directory a wave placed this record in moved under it', dir);
    };
    return () => {
        let route;
        try {
            route = ns.mutationRoute(dir, { follow: true });
        }
        catch {
            return moved();
        }
        if (route instanceof Promise)
            return route.then((now) => { if (now.path !== dir)
                moved(); }, moved);
        if (route.path !== dir)
            moved();
    };
}
async function applyRecord(ns, cleanup, record, pinned) {
    switch (record.type) {
        case 'directory':
            await pinned();
            await ns.mkdir(record.path, { recursive: true, mode: record.mode });
            return null;
        case 'delete': {
            await pinned();
            if ((await ns.stat(record.path, { follow: false })) === null)
                return null;
            await pinned();
            const removal = await ns.removeRecursive(record.path);
            if (removal.kept.length > 0 || removal.failures.length > 0) {
                const first = removal.failures[0];
                const code = first?.error.code ?? 'EIO';
                throw new VfsError(code, `rm -r removed ${removal.removed.length}, kept ${removal.kept.length}${removal.kept.length > 0 ? ` (${removal.kept.slice(0, 3).join(', ')})` : ''}, failed ${removal.failures.length}${first ? ` (${first.path}: ${first.error.message})` : ''}`, record.path);
            }
            return null;
        }
        case 'symlink': {
            const staged = `${parentOf(record.path) === '/' ? '' : parentOf(record.path)}/.${nameOf(record.path)}${STAGED_LINK_SUFFIX}`;
            await sweepStagedLinks(cleanup, parentOf(record.path), pinned);
            // A crash's leftover under this very name.
            await pinned();
            if ((await cleanup.stat(staged, { follow: false })) !== null)
                await cleanup.unlink(staged);
            await pinned();
            await ns.symlink(record.target, staged);
            try {
                await pinned();
                await ns.rename(staged, record.path);
            }
            catch (error) {
                await cleanup.unlink(staged).catch(() => { });
                throw error;
            }
            return statOf(await ns.stat(record.path, { follow: false }));
        }
        case 'file':
            return writeInPlace(ns, record, pinned);
    }
}
/**
 * A file as open(O_TRUNC) and writes make it: writeFile with its first
 * chunk, then each further chunk at its offset into the same inode, through
 * a link at its name. A backend that writes no ranges takes it whole.
 */
async function writeInPlace(ns, record, pinned) {
    const chunks = record.chunks[Symbol.asyncIterator]();
    const firstStep = await chunks.next();
    const first = firstStep.done ? null : firstStep.value;
    try {
        await pinned();
        await ns.writeFile(record.path, first?.data ?? new Uint8Array(0), { mode: record.mode });
    }
    catch (error) {
        first?.release();
        await drain(chunks);
        throw error;
    }
    // The file the name reached, and its inode: what every further chunk goes into.
    const target = (await ns.mutationRoute(record.path, { follow: true })).path;
    const inode = (await ns.stat(target, { follow: false }))?.ino;
    const sameInode = async () => {
        if ((await ns.stat(target, { follow: false }))?.ino !== inode) {
            throw new VfsError('ESTALE', 'the file a wave was writing was replaced under it', record.path);
        }
    };
    let offset = first?.data.byteLength ?? 0;
    // The first chunk keeps its credit until a range write shows the backend takes ranges.
    let held = first === null ? null : [first];
    try {
        for (let step = await chunks.next(); !step.done; step = await chunks.next()) {
            const chunk = step.value;
            if (held !== null && held.length > 1) {
                // Taking the file whole: a backend without ranges.
                held.push(chunk);
                continue;
            }
            try {
                await sameInode();
                await ns.writeRange(target, offset, chunk.data);
            }
            catch (error) {
                if (held === null || error.code !== 'ENOTSUP') {
                    chunk.release();
                    throw error;
                }
                if (record.size > HELD_FILE_BYTES) {
                    chunk.release();
                    throw new VfsError('ENOTSUP', `a wave's file goes to a mount that writes no ranges whole, up to ${HELD_FILE_BYTES} bytes; this one is ${record.size}`, record.path);
                }
                held.push(chunk);
                continue;
            }
            offset += chunk.data.byteLength;
            chunk.release();
            if (held !== null) {
                for (const kept of held)
                    kept.release();
                held = null;
            }
        }
        if (held !== null && held.length > 1) {
            const bytes = new Uint8Array(record.size);
            let at = 0;
            for (const chunk of held) {
                bytes.set(chunk.data, at);
                at += chunk.data.byteLength;
            }
            await sameInode();
            await ns.writeFile(target, bytes, { mode: record.mode });
        }
    }
    catch (error) {
        await drain(chunks);
        throw error;
    }
    finally {
        for (const chunk of held ?? [])
            chunk.release();
    }
    return statOf(await ns.stat(target, { follow: false }));
}
/** Staged links a crash left in `dir`: removed once older than STAGED_LINK_STALE_MS. */
async function sweepStagedLinks(cleanup, dir, pinned) {
    let entries;
    try {
        entries = await cleanup.readdir(dir);
    }
    catch {
        return;
    }
    const now = Date.now();
    for (const { name } of entries) {
        if (!name.startsWith('.') || !name.endsWith(STAGED_LINK_SUFFIX))
            continue;
        const path = `${dir === '/' ? '' : dir}/${name}`;
        const stat = await cleanup.stat(path, { follow: false }).catch(() => null);
        if (stat === null || stat.type !== 'symlink' || now - stat.mtimeMs < STAGED_LINK_STALE_MS)
            continue;
        await pinned();
        await cleanup.unlink(path).catch(() => { });
    }
}
/** What the wave hands over after a failure goes back to it as it comes. */
async function drain(chunks) {
    try {
        for (let step = await chunks.next(); !step.done; step = await chunks.next())
            step.value.release();
    }
    catch {
        // The wave failed too: its queue released what it held.
    }
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
