/**
 * A process's own permission checks, by the one POSIX calculation
 * (core posixAccess). What differs between callers is only what they make of
 * metadata or a credential that is absent, and that is all that is here.
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
/**
 * Whether a program running as `cred` may `want` a path whose stat is
 * `meta`. Only a stat that states the owner, group and mode can be judged;
 * one that does not is not judged in the process's favour: absent fields
 * used to default to mode 0644 and owner 1000, which made any undescribed
 * file the reader's own.
 */
export function programAllows(cred, meta, want) {
    if (want === 0)
        return true;
    const mode = Number(meta?.mode);
    const uid = Number(meta?.uid);
    const gid = Number(meta?.gid);
    if (!Number.isInteger(mode) || !Number.isInteger(uid) || !Number.isInteger(gid))
        return false;
    return posixAccess({ mode, uid, gid }, want, { uid: Number(cred.uid), gid: Number(cred.gid), groups: groupsOf(cred) });
}
