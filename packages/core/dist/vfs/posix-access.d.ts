/**
 * POSIX permission classes: the one calculation of whether a credential
 * holds `want` (r=4, w=2, x=1) on an entry whose mode and owner are known.
 * The owner class when the uid matches, else the group class when the gid
 * or a supplementary group does, else other; root reads and writes
 * anything and executes what anyone may. A caller keeps its own policy for
 * an entry whose metadata is absent (the runtime bridge allows, a facet's
 * shim denies).
 */
export declare function posixAccess(entry: {
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
}, want: number, cred: {
    readonly uid: number;
    readonly gid: number;
    readonly groups: readonly number[];
}): boolean;
//# sourceMappingURL=posix-access.d.ts.map