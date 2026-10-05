/**
 * git/worktree/checkout.ts — moving the worktree and index to another commit
 * (a branch switch, a fast-forward, reset --hard), touching only what moves.
 *
 * Unforced, it is git's twoway merge (unpack-trees.c twoway_merge) of the
 * index against HEAD's tree and the target's: the paths that differ between
 * the two trees are found by comparing them (a subtree both hold with the
 * same id is never read), and only those paths, the directories a file
 * replaces and what is under them, are looked at. An entry HEAD and the
 * target agree on keeps the index and worktree as they are; one the index
 * holds as HEAD has it takes the target's, if the worktree still matches the
 * index (verify_uptodate); anything else refuses as a local change. A path
 * git does not track may be overwritten only if ignored (verify_absent), and
 * a directory a file replaces may go only if all that is untracked in it is
 * ignored (verify_clean_subdirectory). Forced (reset --hard) it is a oneway
 * merge: the paths where the index or the worktree differ from the target
 * take the target's, and untracked paths in its way go.
 *
 * Refusals are reported together, as git reports them, before anything is
 * written. Then files go, directories go (deepest first), directories come,
 * files come, and the index is written once.
 */
import { type DirCache, type IndexEdit } from './dircache.js';
import type { Excludes } from './excludes.js';
import { type ObjectStore } from './tree.js';
import { type Worktree } from './walk.js';
/** The worktree writes a checkout makes, at absolute paths (createGitFs's checkout rules). */
export interface CheckoutWriter {
    writeFile(path: string, data: Uint8Array): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    chmod(path: string, mode: number): Promise<void>;
}
/** What a refused checkout names, by git's kinds. */
export interface Refusal {
    local: string[];
    directories: string[];
    untracked: string[];
}
export declare class CheckoutRefused extends Error {
    readonly refusal: Refusal;
    constructor(refusal: Refusal);
}
export interface SwitchContext {
    store: ObjectStore;
    tree: Worktree;
    dc: DirCache;
    excludes: Excludes;
    /** The worktree's top, absolute. */
    root: string;
    writer: CheckoutWriter;
}
/**
 * Move the worktree from `head` (a tree; null when forced or unborn) to
 * `target` (a tree), and answer the index edit that goes with it. Throws
 * CheckoutRefused, having written nothing, when git would refuse.
 */
export declare function switchTrees(ctx: SwitchContext, head: string | null, target: string, force: boolean): Promise<IndexEdit>;
//# sourceMappingURL=checkout.d.ts.map