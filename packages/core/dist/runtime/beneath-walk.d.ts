/**
 * The walk beneath a root (RESOLVE_BENEATH, a WASI preopen) and the two
 * rules it reads — POSIX permission bits and Node's error for a failed call —
 * in a module that imports no filesystem, so a facet that answers lookups
 * from its own copy of the namespace (wasi/resident-filesystem.ts) walks with
 * exactly the code the authority walks with (sqlite-runtime-fs-bridge.ts).
 */
import type { RuntimeFsPath } from './os-contracts.js';
/** Links followed before ELOOP (Linux MAXSYMLINKS). */
export declare const MAX_LINK_HOPS = 40;
/** An error carrying the fields Node's `fs` puts on a failed syscall. */
export interface FsError extends Error {
    code: string;
    syscall: string;
    path: string;
    /** The second path of a call that names two (rename, symlink's link). */
    dest?: string;
}
/**
 * Node's error for `syscall` failing on `path`: `ENOENT: no such file or
 * directory, open 'x'`, and `rename 'a' -> 'b'` for a call naming `dest` too.
 */
export declare function fsError(code: string, syscall: string, path: RuntimeFsPath, dest?: RuntimeFsPath, options?: {
    detail?: string;
    cause?: unknown;
}): FsError;
/** POSIX rwx for `cred` on a stat (posixAccess); a stat without a mode allows. An absent owner or group is no one's. */
export declare function modeAllows(stat: {
    mode?: number;
    uid?: number;
    gid?: number;
}, want: number, cred: {
    uid: number;
    gid: number;
    groups: readonly number[];
}): boolean;
/** One lookup a walk beneath a root asks of its filesystem: a stat that does not follow a link (null when absent), or a link's target. */
export type BeneathLookup = {
    readonly stat: string;
} | {
    readonly readlink: string;
};
type BeneathAnswer = {
    type: string;
    mode?: number;
    uid?: number;
    gid?: number;
} | string | null;
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
export declare function walkBeneath(root: string, path: RuntimeFsPath, follow: boolean, cred: {
    uid: number;
    gid: number;
    groups: readonly number[];
}, handedOver: (path: string, to: string) => boolean): Generator<BeneathLookup, string | null, BeneathAnswer>;
export {};
//# sourceMappingURL=beneath-walk.d.ts.map