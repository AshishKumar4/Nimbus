import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
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
/**
 * posixAccess for a filesystem's stat, as the session's views judge one: a
 * stat without a mode (a backend that keeps none) is not judged, and an
 * owner or group it keeps none of is no one's.
 */
export declare function modeAllows(stat: {
    readonly mode?: number;
    readonly uid?: number;
    readonly gid?: number;
    readonly type: PosixNodeType;
}, want: number, cred: {
    readonly uid: number;
    readonly gid: number;
    readonly groups: readonly number[];
}): boolean;
/** The caller a metadata rule judges: its uid, its primary group and its supplementary groups. */
export interface PosixCred {
    readonly uid: number;
    readonly gid: number;
    readonly groups: readonly number[];
}
/** chmod(2)'s rule: only the owner or root changes a mode (EPERM). */
export declare function chmodRefusal(entry: {
    readonly uid: number;
}, cred: Pick<PosixCred, 'uid'>): 'EPERM' | null;
/**
 * The mode change a confined principal may not make (EPERM): granting a
 * setuid, setgid, group or other bit the entry lacks, or clearing its sticky
 * bit. A confined principal owns its own triad and nothing else.
 */
export declare function confinedModeRefusal(current: number, next: number): 'EPERM' | null;
/**
 * chown(2)'s rule (EPERM): root changes anything; the owner may keep its
 * owner and set the group to the entry's own or one in `cred.groups`; no one else
 * may name an owner or group at all. A null id leaves it as it is.
 */
export declare function chownRefusal(entry: {
    readonly uid: number;
    readonly gid: number;
}, uid: number | null, gid: number | null, cred: PosixCred): 'EPERM' | null;
/** The mode a chown leaves: a caller other than root clears the setuid and setgid bits. */
export declare function chownedMode(mode: number, cred: Pick<PosixCred, 'uid'>): number;
/** Whether a utimes asks for an explicit time on either side: what utimesRefusal's `explicit` is. */
export declare function explicitTimes(atime: FsTime, mtime: FsTime): boolean;
/** `time` as the filesystem committing it lands it: an explicit one in whole ms, 'now' at `now`, 'omit' as `kept`. */
export declare function timeAt(time: FsTime, kept: number, now: number): number;
/**
 * utimes(2)'s rule: explicit times only by the owner or root (EPERM); the
 * current time by anyone who may write the entry (EACCES).
 */
export declare function utimesRefusal(entry: {
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
    readonly type: PosixNodeType;
}, explicit: boolean, cred: PosixCred): 'EPERM' | 'EACCES' | null;
//# sourceMappingURL=posix-access.d.ts.map