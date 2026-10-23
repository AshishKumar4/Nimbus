/**
 * The namespace's permission checks, by the one POSIX calculation (core
 * posixAccess): what is here is only what the namespace makes of metadata or
 * a credential that is absent.
 */
import { type PosixNodeType } from '@nimbus-sh/core/vfs/posix-access.js';
/** The credential a process runs as, as its launch carries it. */
export interface ResidentCred {
    uid: number;
    gid: number;
    groups?: readonly number[];
    umask?: number;
}
/** What a check reads of a name: a namespace row, or a listing's or a delta's stat. */
export interface ModeMeta {
    readonly mode?: unknown;
    readonly uid?: unknown;
    readonly gid?: unknown;
}
/** The credential's groups, as numbers. */
export declare const groupsOf: (cred: ResidentCred) => readonly number[];
/**
 * Whether the namespace's credential may `want` (r=4, w=2, x=1) what `meta`
 * describes, an entry of `type`, as the session's own check answers a read
 * (SqliteVFS.checkAccess). No credential judges nothing: everything is
 * allowed. Missing fields are read as numbers (absent mode grants nothing,
 * absent owner matches no one).
 */
export declare function namespaceAllows(cred: ResidentCred | null, meta: ModeMeta | undefined, type: PosixNodeType, want: number): boolean;
//# sourceMappingURL=permissions.d.ts.map