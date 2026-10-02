/**
 * mv's move, for any VFS: rename(2) where the filesystem can, and where it
 * answers EXDEV (another filesystem, or a backend that cannot rename in
 * place) a carry that happens whole or not at all.
 *
 * The carry stages a copy beside the destination and confirms it, then
 * removes the source, then puts the copy in the destination's place with one
 * rename. Until that rename the destination keeps what it held. A failure at
 * any step puts back what of the source had gone and removes the staged
 * copy, so a failed move leaves both names as they were. A backend that
 * cannot rename in place has the destination replaced where it is, after
 * what it held is kept to put back.
 *
 * Everything it creates is created private (the owner's bits only, as GNU
 * cp creates a copy before it sets the mode) and given its own mode once its
 * content is complete, so no one reads a copy its source would not let them.
 *
 * Neither atomic to a reader nor across a crash: from the source's removal
 * to the final rename, what is moving is only at the staged name,
 * `.nimbus-move-<id>` in the destination's directory.
 */
import { type VfsError } from './vfs-error.js';
import type { Awaitable, VFS } from './vfs.js';
/** A namespace to move within: a VFS, and its realpath where it has one (links are otherwise walked with readlink). */
export type MoveFs = VFS & {
    realpath?(path: string): Awaitable<string>;
};
export interface MoveOptions {
    /**
     * A copied entry's mode or times the destination refused. They are carried
     * best effort, as GNU mv carries them (mv.c: require_preserve = false), so
     * the move still happens; `path` is where the entry ends up.
     */
    onPreserveFailure?(failure: {
        what: 'times' | 'permissions';
        path: string;
        error: VfsError;
    }): Awaitable<void>;
}
/** Move `from` to `to` as mv does: one rename, or a carry across filesystems (above). Directories too. */
export declare function move(fs: MoveFs, from: string, to: string, options?: MoveOptions): Promise<void>;
//# sourceMappingURL=move.d.ts.map