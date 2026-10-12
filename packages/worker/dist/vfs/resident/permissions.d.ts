/**
 * A process's own permission checks, by the one POSIX calculation
 * (core posixAccess). What differs between callers is only what they make of
 * metadata or a credential that is absent, and that is all that is here.
 */
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
/**
 * Whether the namespace's credential may `want` (r=4, w=2, x=1) what `meta`
 * describes, as the session's own check answers a read
 * (SqliteVFS.checkAccess). No credential judges nothing: everything is
 * allowed. Missing fields are read as numbers (absent mode grants nothing,
 * absent owner matches no one).
 */
export declare function namespaceAllows(cred: ResidentCred | null, meta: ModeMeta | undefined, want: number): boolean;
/**
 * Whether a program running as `cred` may `want` a path whose stat is
 * `meta`. Only a stat that states the owner, group and mode can be judged;
 * one that does not is not judged in the process's favour: absent fields
 * used to default to mode 0644 and owner 1000, which made any undescribed
 * file the reader's own.
 */
export declare function programAllows(cred: ResidentCred, meta: ModeMeta | undefined | null, want: number): boolean;
//# sourceMappingURL=permissions.d.ts.map