/**
 * A backend's listing as its feed gives it (VfsChanges.list), and the feed
 * of a backend whose tree does not change while it is mounted (/dev; /proc,
 * whose generated files' content is not its tree): every cursor of its
 * epoch is current, nothing has changed since one, and its listing is its
 * whole tree. A mount states its change model by its feed (VFS.changes); an
 * immutable one states it so, and is answered from what a reader listed as
 * any fed mount is.
 *
 * Its epoch is its tree's: every name with its type, size, mode and owner,
 * as `stat` and `readdir` say them now. A tree that changes (a /proc file
 * registered) is another epoch, so a reader holding the last one lists
 * again.
 */
import type { VfsBackendPage, VfsListEntry } from '../runtime/os-contracts.js';
import type { SyncVFS, VfsChanges } from './vfs.js';
/** Every name in `vfs` but its root, absolute, as its own lstat says it (a link with its target), in path order. */
export declare function treeListing(vfs: Pick<SyncVFS, 'stat' | 'readdir'> & Partial<Pick<SyncVFS, 'readlink'>>): VfsListEntry[];
/** The page of `entries` (in path order) after `after`, `limit` long, at `epoch` and `rev`; each entry its own copy. */
export declare function pageOf(entries: readonly VfsListEntry[], after: string | null, limit: number, epoch: string, rev: number): VfsBackendPage;
/**
 * The feed of `vfs`, whose tree changes only when `version` does (a /proc
 * registration): its listing and epoch are taken once a version.
 */
export declare function immutableChanges(vfs: Pick<SyncVFS, 'stat' | 'readdir'>, version?: () => number): VfsChanges;
//# sourceMappingURL=immutable-changes.d.ts.map