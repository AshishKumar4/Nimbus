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
 * A routed record is the single call a program would make on that mount,
 * at the place the lookup resolved:
 *   - a directory: mkdir -p, a directory already there kept;
 *   - a file: one whole-file writeFile (following a link at its name,
 *     keeping an existing file's mode, owner and inode), its bytes held
 *     under the wave's credit until that call, up to ROUTED_FILE_MAX;
 *   - a link: made at the wave's own slot beside its name, then renamed
 *     over it (as ln -sf does), so a backend that cannot make it refuses
 *     before the old entry goes;
 *   - a removal: rm -r, refused (naming what stayed) when it kept or failed
 *     to remove anything.
 * Each call first checks that the record's directory still resolves to the
 * place it was given; one that moved refuses the record (ESTALE).
 *
 * A link's slot is `.<name>.nimbus-wave-<wave>-<record>`, the wave's own:
 * no other operation's slot is touched. A wave that fails between the slot
 * and the rename removes its slot; a crash in that window leaves it, at
 * most one per link record in flight (a known leak, by that name pattern).
 */
import { VfsError } from '../vfs/vfs-error.js';
/** The suffix of a link's slot: `.<name>${LINK_SLOT_SUFFIX}-<wave>-<record>`. */
export const LINK_SLOT_SUFFIX = '.nimbus-wave';
export function namespaceWaveRouter(namespace, credential) {
    const view = (cred, guard) => {
        const as = namespace.as(credential(cred));
        return guard === undefined ? as : as.scoped(guard);
    };
    return {
        mounts: () => namespace.mountGeneration(),
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
            // On the root, a name is this filesystem's: one under a directory above
            // a mount point too, which the namespace shows once the root holds it.
            const point = namespace.mountOf(path);
            return point === '/' ? null : point;
        },
        composes(path) {
            return namespace.isAboveMount(path);
        },
        async apply(record, cred, guard) {
            const ns = view(cred, guard);
            // Removing its own slot after a failure is the record's own, unguarded.
            const cleanup = view(cred);
            return applyRecord(ns, cleanup, record, pinsOf(ns, record));
        },
    };
}
function parentOf(path) {
    return path.slice(0, path.lastIndexOf('/')) || '/';
}
/** Every directory the record names a place in, pinned (a rename's two). */
function pinsOf(ns, record) {
    const dirs = record.type === 'rename' ? [parentOf(record.from), parentOf(record.to)]
        : [parentOf(record.type === 'call' ? record.call.path : record.path)];
    const pins = dirs.map((dir) => pinOf(ns, dir));
    if (pins.length === 1)
        return pins[0];
    return () => {
        const pending = pins.map((pin) => pin()).filter((result) => result instanceof Promise);
        if (pending.length > 0)
            return Promise.all(pending).then(() => { });
    };
}
/**
 * An rm -r's removal, whole or refused: what it kept or failed on is the
 * call's error (its first failure's code), never a partial removal answered
 * as done.
 */
function removedWhole(removal, path) {
    if (removal.kept.length === 0 && removal.failures.length === 0)
        return;
    const first = removal.failures[0];
    const code = first?.error.code ?? 'EIO';
    throw new VfsError(code, `rm -r removed ${removal.removed.length}, kept ${removal.kept.length}${removal.kept.length > 0 ? ` (${removal.kept.slice(0, 3).join(', ')})` : ''}, failed ${removal.failures.length}${first ? ` (${first.path}: ${first.error.message})` : ''}`, path);
}
/**
 * The record's directory, pinned: refuses (ESTALE) when it no longer
 * resolves to `dir`, the place the record was given. Synchronous while the
 * lookup is, so the call it precedes is made in the same turn.
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
            removedWhole(await ns.removeRecursive(record.path), record.path);
            return null;
        }
        case 'symlink': {
            const dir = parentOf(record.path);
            const slot = `${dir === '/' ? '' : dir}/.${record.path.slice(record.path.lastIndexOf('/') + 1)}${LINK_SLOT_SUFFIX}-${record.slot}`;
            await pinned();
            await ns.symlink(record.target, slot);
            try {
                await pinned();
                await ns.rename(slot, record.path);
            }
            catch (error) {
                await cleanup.unlink(slot).catch(() => { });
                throw error;
            }
            return statOf(await ns.stat(record.path, { follow: false }));
        }
        case 'file':
            await pinned();
            await ns.writeFile(record.path, record.bytes, { mode: record.mode });
            return statOf(await ns.stat(record.path));
        case 'call': {
            // The call itself, as the namespace makes it: its own refusals (EEXIST, ENOTEMPTY, …).
            const call = record.call;
            await pinned();
            if (call.call === 'mkdir') {
                // `existing: 'ok'`: a directory there is made already, as mkdir -p takes it.
                const there = call.existing === 'ok' ? await ns.stat(call.path) : null;
                await pinned();
                if (there === null || there.type !== 'directory')
                    await ns.mkdir(call.path, { mode: call.mode });
            }
            else if (call.call === 'unlink')
                await ns.unlink(call.path);
            else if (call.call === 'rmdir')
                await ns.rmdir(call.path);
            // An open description's truncate, by its name: a mount numbers its files its own way.
            else if (call.call === 'ftruncate')
                await ns.truncate(call.path, call.size);
            else if (call.call === 'rm') {
                // The name itself, a link not followed: rm removes the link.
                const there = await ns.stat(call.path, { follow: false });
                await pinned();
                if (there === null) {
                    if (!call.force)
                        throw new VfsError('ENOENT', 'no such file or directory', call.path);
                }
                else if (there.type === 'directory') {
                    if (!call.recursive)
                        throw new VfsError('EISDIR', 'is a directory', call.path);
                    await pinned();
                    removedWhole(await ns.removeRecursive(call.path), call.path);
                }
                else {
                    await pinned();
                    await ns.unlink(call.path);
                }
            }
            // A mount keeps no owner or times of a link apart from what it names: refused, as a backend without them refuses.
            else if (call.call === 'lchown' || call.call === 'lutimes')
                throw new VfsError('ENOTSUP', `${call.call} on a mount`, call.path);
            else
                await ns.symlink(call.target, call.path);
            return null;
        }
        case 'rename':
            await pinned();
            await ns.rename(record.from, record.to);
            return null;
        case 'truncate':
            await pinned();
            await ns.truncate(record.path, record.size);
            return statOf(await ns.stat(record.path));
        case 'setattr': {
            // Followed, as the session's own chmod, chown and utimes of a process's setattr are.
            await pinned();
            const attrs = record.attrs;
            if ('mode' in attrs)
                await ns.chmod(record.path, attrs.mode);
            else if ('uid' in attrs)
                await ns.chown(record.path, attrs.uid, attrs.gid);
            else
                await ns.utimes(record.path, attrs.atime, attrs.mtime);
            return statOf(await ns.stat(record.path));
        }
        case 'data-call': {
            // The namespace's call with the whole bytes; a description's write or
            // append by its name, as a mount numbers its files its own way.
            await pinned();
            if (record.call === 'appendFile' || record.call === 'append') {
                const prior = await ns.stat(record.path);
                await pinned();
                if (prior === null && record.call === 'appendFile')
                    await ns.writeFile(record.path, record.bytes, { mode: record.mode });
                else if (prior === null)
                    throw new VfsError('ENOENT', 'the file an open description appends to is gone', record.path);
                else
                    await ns.writeRange(record.path, prior.size, record.bytes);
            }
            else if (record.call === 'write') {
                await ns.writeRange(record.path, record.offset ?? 0, record.bytes);
            }
            else {
                await ns.writeFile(record.path, record.bytes, { mode: record.mode });
            }
            return statOf(await ns.stat(record.path));
        }
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
