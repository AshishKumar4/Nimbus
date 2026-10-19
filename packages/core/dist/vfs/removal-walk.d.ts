/**
 * removal-walk.ts — rm -r's walk: the one place its per-entry decisions are
 * made, for CompositeVFS's walk over any backend and for SqliteVFS's own
 * removal of a tree in which something may be refused.
 *
 * GNU rm -r's: every entry is stat'ed without following links and each
 * directory read, children before the directory holding them; each entry
 * is then removed (unlink, or rmdir for a directory). An entry whose removal
 * is refused stays, and so does every directory holding it; the walk carries
 * on past it. One that is gone when it is stat'ed, read or removed has
 * vanished, which is no failure: with `keepVanishedAncestors` the
 * directories holding it stay, as GNU leaves them, otherwise they go. A
 * directory that could not be read reports that refusal, not its rmdir's.
 * A directory the walk does not cross (a mount point, as GNU rm
 * --one-file-system keeps out of one) is neither read nor removed: it stays,
 * with what holds it, and is reported EBUSY.
 */
import { type Awaitable, type VfsRemoval, type VfsStat } from './vfs.js';
/** What the walk does to the tree, on paths of the walk's own (`rel` and below). */
export interface RemovalSteps {
    /** `r` itself, not followed: null when it is not there; a throw is lstat's refusal. */
    lstat(r: string): Awaitable<Pick<VfsStat, 'type'> | null>;
    /** The names in directory `r`; a throw is scandir's refusal. */
    readdir(r: string): Awaitable<readonly {
        name: string;
    }[]>;
    /** Remove `r` (rmdir when `dir`, else unlink); a throw is that call's refusal. */
    remove(r: string, dir: boolean): Awaitable<void>;
    /** Whether the walk may enter directory `r`: false for one it must keep out of (a mount point). */
    crosses?(r: string): boolean;
}
export interface RemovalWalk {
    /** The operand, on the steps' paths. */
    rel: string;
    /** A path of the steps' as the report names it. */
    at(r: string): string;
    keepVanishedAncestors: boolean;
    /** What the operand not being there throws. */
    missing(): Error;
    /** A refusal that is not the entry's, and ends the walk (a recall, a caller that cannot wait). */
    passes(cause: unknown): boolean;
}
/** rm -r of `walk.rel` by `steps`, with its exact report (VfsRemoval). */
export declare function walkRemoval(steps: RemovalSteps, walk: RemovalWalk): Awaitable<VfsRemoval>;
//# sourceMappingURL=removal-walk.d.ts.map