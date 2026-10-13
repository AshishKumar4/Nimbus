/** What an entry is, as its filesystem says: the type every access check is given. */
export type PosixNodeType = 'file' | 'directory' | 'symlink';
/**
 * POSIX permission classes: the one calculation of whether a credential
 * holds `want` (r=4, w=2, x=1) on an entry whose mode, owner and type are
 * known. The owner class when the uid matches, else the group class when the
 * gid or a supplementary group does, else other. Root holds Linux's
 * CAP_DAC_OVERRIDE and CAP_DAC_READ_SEARCH: it reads and writes anything and
 * searches every directory, and executes a file only when some execute bit
 * is set on it. The type is the entry's own, never read from its mode: a
 * stored mode may carry no file-type bits (mkdir keeps the bits it is
 * given). A caller keeps its own policy for an entry whose metadata is absent
 * (the runtime bridge allows, a facet's shim denies).
 */
export declare function posixAccess(entry: {
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
    readonly type: PosixNodeType;
}, want: number, cred: {
    readonly uid: number;
    readonly gid: number;
    readonly groups: readonly number[];
}): boolean;
//# sourceMappingURL=posix-access.d.ts.map