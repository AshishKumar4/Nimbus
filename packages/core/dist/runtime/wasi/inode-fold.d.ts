/**
 * An inode as this process sees it while its own operations are pending:
 * its admitted baseline (the view's row, and its bytes where the view holds
 * them) with each pending operation folded over it in log order (VFS-9 B
 * stage 3, rev 5 §0.2). One fold serves an appended operation, applied in
 * O(op); a re-fold from the baseline after a refusal or a rebase; and the
 * merge of two inodes (canonicalize), their operations spliced in log order.
 *
 * Plain values in, plain values out: nothing here reads the store, the log
 * or a clock.
 */
import type { FsTime } from '@nimbus-sh/platform/w7-frame.js';
/** What an inode is, as far as its own operations change it. */
export interface InodeState {
    /** Its bytes, the first `size` of them; null where the baseline's bytes are not held (its size is still known). */
    bytes: Uint8Array | null;
    size: number;
    /** st_mode, the type bits included. */
    mode: number;
    uid: number;
    gid: number;
    atime: number;
    mtime: number;
    ctime: number;
}
/** One of the process's own operations on an inode, as logged; `at` is when it was decided (its times). */
export type InodeOp = {
    readonly kind: 'write';
    readonly offset: number;
    readonly data: Uint8Array;
    readonly at: number;
} | {
    readonly kind: 'append';
    readonly data: Uint8Array;
    readonly at: number;
} | {
    readonly kind: 'truncate';
    readonly size: number;
    readonly at: number;
} | {
    readonly kind: 'chmod';
    readonly mode: number;
    readonly at: number;
}
/** A side null is kept. A chown by anyone but root clears the set-id bits (chownedMode). */
 | {
    readonly kind: 'chown';
    readonly uid: number | null;
    readonly gid: number | null;
    readonly by: number;
    readonly at: number;
} | {
    readonly kind: 'utimes';
    readonly atime: FsTime;
    readonly mtime: FsTime;
    readonly at: number;
};
/**
 * A private copy of the first `length` of `bytes`: a plain array no one else
 * holds, whatever `bytes` is (a Buffer's slice is a view of it, not a copy).
 */
export declare function owned(bytes: Uint8Array, length?: number): Uint8Array;
/** A copy of `state` that folding into does not change `state`. */
export declare function copyState(state: InodeState): InodeState;
/**
 * `op` applied to `state`, in place: O(op) but for a buffer that has to
 * grow. Bytes past the end a write starts at are zero, as a hole reads; an
 * append lands at the end; a truncate cuts or zero-extends, and to nothing
 * makes the content known (nothing of the baseline is left). Content
 * operations stamp mtime and ctime; attribute operations ctime. A write or
 * append of no bytes changes nothing, as the authority's does.
 */
export declare function applyOp(state: InodeState, op: InodeOp): InodeState;
/** `ops` folded over a copy of `baseline`, in order: what the inode is with them pending. */
export declare function foldOps(baseline: InodeState, ops: Iterable<InodeOp>): InodeState;
//# sourceMappingURL=inode-fold.d.ts.map