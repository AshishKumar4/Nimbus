/**
 * git/sparse-checkout.ts — `git sparse-checkout` (builtin/sparse-checkout.c),
 * in cone mode: list, set, add, reapply, disable and init.
 *
 * The cone lives in info/sparse-checkout (pack/sparse.ts writes and reads
 * it) and is switched on by core.sparseCheckout and core.sparseCheckoutCone
 * in config.worktree (extensions.worktreeConfig set first, as git's
 * init_worktree_config does). Changing it moves the worktree as git's
 * update_working_directory does, before the new file is written: the cone
 * applied to every index entry (worktree/checkout.ts updateSparsity), what
 * is left named, then each directory outside the cone that holds nothing
 * tracked removed, unless untracked or ignored files are in it
 * (clean_tracked_sparse_directories). A sparse checkout that is not cone
 * mode is refused, as the rest of this git refuses it.
 */
import { type CheckoutWriter } from './worktree/checkout.js';
import { type WorktreeRepo } from './worktree/repo.js';
export interface SparseCheckoutContext {
    wrepo: WorktreeRepo;
    /** The worktree's top, absolute. */
    root: string;
    /** The command's directory below the top, '' or ending in '/' (git's prefix). */
    prefix: string;
    writer: CheckoutWriter;
    stdout(text: string): Promise<void>;
    stderr(text: string): Promise<void>;
}
/** `git sparse-checkout <subcommand> [<options>]`. */
export declare function sparseCheckout(ctx: SparseCheckoutContext, args: readonly string[]): Promise<number>;
//# sourceMappingURL=sparse-checkout.d.ts.map