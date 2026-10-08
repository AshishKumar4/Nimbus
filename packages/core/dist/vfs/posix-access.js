/**
 * POSIX permission classes: the one calculation of whether a credential
 * holds `want` (r=4, w=2, x=1) on an entry whose mode and owner are known.
 * The owner class when the uid matches, else the group class when the gid
 * or a supplementary group does, else other; root reads and writes
 * anything and executes what anyone may. A caller keeps its own policy for
 * an entry whose metadata is absent (the runtime bridge allows, a facet's
 * shim denies).
 */
export function posixAccess(entry, want, cred) {
    const requested = want & 0o7;
    if (requested === 0)
        return true;
    const permissions = entry.mode & 0o777;
    if (cred.uid === 0)
        return (requested & 0o1) === 0 || (permissions & 0o111) !== 0;
    const shift = cred.uid === entry.uid ? 6 : cred.gid === entry.gid || cred.groups.includes(entry.gid) ? 3 : 0;
    return ((permissions >> shift) & requested) === requested;
}
