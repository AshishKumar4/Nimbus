/**
 * The walk beneath a root (RESOLVE_BENEATH, a WASI preopen) and the two
 * rules it reads — POSIX permission bits and Node's error for a failed call —
 * in a module that imports no filesystem, so a facet that answers lookups
 * from its own copy of the namespace (wasi/resident-filesystem.ts) walks with
 * exactly the code the authority walks with (sqlite-runtime-fs-bridge.ts).
 */
import { fsError as nodeFsError } from '../vfs/vfs-error.js';
import { posixAccess } from '../vfs/posix-access.js';
/** Links followed before ELOOP (Linux MAXSYMLINKS). */
export const MAX_LINK_HOPS = 40;
/** vfs-error.ts's fsError for a call on a runtime path, named by its path. */
export function fsError(code, syscall, path, dest, options = {}) {
    const name = typeof path === 'string' ? path : path.path;
    const second = dest === undefined ? undefined : typeof dest === 'string' ? dest : dest.path;
    return nodeFsError(code, syscall, name, second, options);
}
/** POSIX rwx for `cred` on a stat (posixAccess); a stat without a mode allows. An absent owner or group is no one's. */
export function modeAllows(stat, want, cred) {
    if (stat.mode === undefined)
        return true;
    return posixAccess({ mode: stat.mode, uid: stat.uid ?? -1, gid: stat.gid ?? -1 }, want, cred);
}
/**
 * A lookup beneath `root` (RESOLVE_BENEATH, a WASI preopen), as the
 * namespace walk does it (VFS-COMP-006): the root must be reachable (every
 * directory above it searchable); an absolute path and `..` at the root are
 * ENOTCAPABLE; each component needs the directory it leaves to be a
 * searchable directory; a missing component is ENOENT unless it is the last.
 * Links resolve (the last only when `follow`), 40 hops, then null (ELOOP):
 * a relative one from its directory, an absolute one from the namespace's
 * `/`, as the unrestricted walk resolves them, and what the walk reaches
 * must lie at or under the root, else ENOTCAPABLE. A path the namespace
 * hands to its backend whole beneath this root (`handedOver`, asked with
 * where the lookup goes on to lexically: CompositeVFS.resolvedByBackend
 * within the root, a resolvesPaths mount whose point lies at or under it, so
 * the backend's own links stay beneath it) is neither looked up nor searched
 * here, nor are its links read: its components are taken lexically, `..`
 * included, and that backend answers for them. The one walk for every face: it yields
 * its lookups, which the synchronous bridge answers at once and a face over
 * asynchronous mounts awaits. `root` is normalized; the answer is the
 * resolved path, normalized.
 */
export function* walkBeneath(root, path, follow, cred, handedOver) {
    const name = typeof path === 'string' ? path : path.path;
    if (root !== '')
        yield { stat: '/' + root };
    if (name.startsWith('/'))
        throw fsError('ENOTCAPABLE', 'path', path);
    const pending = name.split('/').filter(Boolean);
    const resolved = root === '' ? [] : root.split('/');
    let hops = 0;
    while (pending.length > 0) {
        const segment = pending.shift();
        const dir = resolved.join('/');
        const candidate = dir === '' ? segment : `${dir}/${segment}`;
        const to = '/' + [dir, segment, ...pending].filter(Boolean).join('/');
        const handed = handedOver('/' + dir, to) || (segment !== '.' && segment !== '..' && handedOver('/' + candidate, to));
        if (!handed) {
            const searched = (yield { stat: '/' + dir });
            if (searched === null)
                throw fsError('ENOENT', 'path', path);
            if (searched.type !== 'directory')
                throw fsError('ENOTDIR', 'path', path);
            if (!modeAllows(searched, 1, cred))
                throw fsError('EACCES', 'path', path);
        }
        if (segment === '.')
            continue;
        if (segment === '..') {
            if (dir === root)
                throw fsError('ENOTCAPABLE', 'path', path);
            resolved.pop();
            continue;
        }
        if (handed) {
            resolved.push(segment);
            continue;
        }
        // Every component already walked is a directory, not a link, so a
        // lookup by its literal name is the walk's own.
        const isFinal = pending.length === 0;
        const stat = (yield { stat: '/' + candidate });
        if (stat === null && !isFinal)
            throw fsError('ENOENT', 'path', path);
        if (stat === null || stat.type !== 'symlink' || (isFinal && !follow)) {
            resolved.push(segment);
            continue;
        }
        if (++hops > MAX_LINK_HOPS)
            return null;
        const target = (yield { readlink: '/' + candidate });
        // A link whose target the namespace has no name for (a mount nested in
        // its backend covers it) cannot be followed beneath the root.
        if (target === null)
            throw fsError('ENOTCAPABLE', 'path', path);
        if (target.startsWith('/'))
            resolved.length = 0;
        pending.unshift(...target.split('/').filter(Boolean));
    }
    const reached = resolved.join('/');
    if (root !== '' && reached !== root && !reached.startsWith(root + '/'))
        throw fsError('ENOTCAPABLE', 'path', path);
    return reached;
}
