/**
 * The namespace's permission checks, by the one POSIX calculation (core
 * posixAccess): what is here is only what the namespace makes of metadata or
 * a credential that is absent.
 */
import { posixAccess } from '@nimbus-sh/core/vfs/posix-access.js';
const groupsOf = (cred) => (Array.isArray(cred.groups) ? cred.groups.map(Number) : []);
/**
 * Whether the namespace's credential may `want` (r=4, w=2, x=1) what `meta`
 * describes, as the session's own check answers a read
 * (SqliteVFS.checkAccess). No credential judges nothing: everything is
 * allowed. Missing fields are read as numbers (absent mode grants nothing,
 * absent owner matches no one).
 */
export function namespaceAllows(cred, meta, want) {
    if (!cred)
        return true;
    return posixAccess({ mode: Number(meta?.mode), uid: Number(meta?.uid), gid: Number(meta?.gid) }, want, { uid: Number(cred.uid), gid: Number(cred.gid), groups: groupsOf(cred) });
}
