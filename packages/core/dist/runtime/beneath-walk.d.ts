/**
 * The walk beneath a root (RESOLVE_BENEATH, a WASI preopen) and the two
 * rules it reads — POSIX permission bits and Node's error for a failed call —
 * in a module that imports no filesystem, so a facet that answers lookups
 * from its own copy of the namespace (wasi/resident-filesystem.ts) walks with
 * exactly the code the authority walks with (sqlite-runtime-fs-bridge.ts).
 */
import type { RuntimeFsPath } from './os-contracts.js';
import { type FsError } from '../vfs/vfs-error.js';
export type { FsError };
/** Links followed before ELOOP (Linux MAXSYMLINKS). */
export declare const MAX_LINK_HOPS = 40;
/** vfs-error.ts's fsError for a call on a runtime path, named by its path. */
export declare function fsError(code: string, syscall: string, path: RuntimeFsPath, dest?: RuntimeFsPath, options?: {
    detail?: string;
    cause?: unknown;
}): FsError;
/** One lookup a walk beneath a root asks of its filesystem: a stat that does not follow a link (null when absent), or a link's target. */
export type BeneathLookup = {
    readonly stat: string;
} | {
    readonly readlink: string;
};
/**
 * What a walk reached: `reached`, the name it resolved to (normalized,
 * relative to the namespace's root), and `spelling`, the name to hand the
 * namespace for it (absolute). Where the walk handed names to a backend that
 * resolves its own paths, with no link it followed after, the spelling is
 * the name reached up to there, then the rest as written, so that backend
 * walks it (CompositeVFS's Resolution.operand); else it is the reached name.
 */
export interface BeneathReached {
    readonly reached: string;
    readonly spelling: string;
}
/**
 * Where a walk began handing names over (`base`, absolute, and the rest as
 * written from there), as BeneathReached.spelling, else `reached` (absolute);
 * `trailing`: the name the walk was given ends in a separator.
 */
export declare function handedSpelling(handoff: {
    base: string;
    rest: readonly string[];
} | null, reached: string, trailing: boolean): string;
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
 * resolved path, normalized, and the spelling to hand the namespace
 * (BeneathReached). `rootSpelling`: the root's own name for its lookups (a
 * directory opened past a `..` a backend walks, HeldFile.name), which every
 * lookup beneath it starts from until an absolute link leaves it; its
 * confinement is the normalized `root`'s.
 */
export declare const walkBeneath: (root: string, path: RuntimeFsPath, follow: boolean, cred: {
    uid: number;
    gid: number;
    groups: readonly number[];
}, handedOver: (path: string, to: string) => boolean, rootSpelling?: string) => Generator<BeneathLookup, BeneathReached | null, BeneathAnswer>;
//# sourceMappingURL=beneath-walk.d.ts.map