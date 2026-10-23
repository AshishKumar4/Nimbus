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
import { chownedMode, timeAt } from '../../vfs/posix-access.js';
import { bytesView, mathMax, objectHasOwn, typedArrayByteLength, typedArrayFill, typedArraySet, Uint8ArrayConstructor } from '../../_shared/primordials.js';
/** One of the process's own operations on an inode, as logged; `at` is when it was decided (its times). */
/** Which change W7Attrs carries, by its own fields: a mode's, an owner's, or times'. */
export const isModeChange = (attrs) => objectHasOwn(attrs, 'mode');
export const isOwnerChange = (attrs) => objectHasOwn(attrs, 'uid');
export const isTimesChange = (attrs) => objectHasOwn(attrs, 'atime');
/**
 * A private copy of the first `length` of `bytes`: a plain array no one else
 * holds, whatever `bytes` is (a Buffer's slice is a view of it, not a copy).
 */
export function owned(bytes, length = typedArrayByteLength(bytes)) {
    const copy = new Uint8ArrayConstructor(length);
    typedArraySet(copy, bytesView(bytes, 0, length));
    return copy;
}
/** A copy of `state` that folding into does not change `state`. */
export function copyState(state) {
    return { ...state, bytes: state.bytes === null ? null : owned(state.bytes, state.size) };
}
/** Room for `size` bytes in `state`'s buffer, its first `state.size` kept, the rest zero. */
function grown(state, size) {
    const bytes = state.bytes;
    if (size <= typedArrayByteLength(bytes))
        return bytes;
    const next = new Uint8ArrayConstructor(mathMax(size, typedArrayByteLength(bytes) * 2, 4096));
    typedArraySet(next, bytesView(bytes, 0, state.size));
    return next;
}
/**
 * `op` applied to `state`, in place: O(op) but for a buffer that has to
 * grow. Bytes past the end a write starts at are zero, as a hole reads; an
 * append lands at the end; a truncate cuts or zero-extends, and to nothing
 * makes the content known (nothing of the baseline is left). Content
 * operations stamp mtime and ctime; attribute operations ctime. A write or
 * append of no bytes changes nothing, as the authority's does.
 */
export function applyOp(state, op) {
    switch (op.kind) {
        case 'write':
        case 'append': {
            if (typedArrayByteLength(op.data) === 0)
                return state;
            const offset = op.kind === 'append' ? state.size : op.offset;
            const end = offset + typedArrayByteLength(op.data);
            if (state.bytes !== null) {
                const bytes = grown(state, end);
                if (offset > state.size)
                    typedArrayFill(bytes, 0, state.size, offset);
                typedArraySet(bytes, op.data, offset);
                state.bytes = bytes;
            }
            state.size = mathMax(state.size, end);
            state.mtime = state.ctime = op.at;
            return state;
        }
        case 'truncate': {
            if (op.size === 0)
                state.bytes = new Uint8ArrayConstructor(0);
            else if (state.bytes !== null && op.size > state.size) {
                const bytes = grown(state, op.size);
                typedArrayFill(bytes, 0, state.size, op.size);
                state.bytes = bytes;
            }
            state.size = op.size;
            state.mtime = state.ctime = op.at;
            return state;
        }
        case 'chmod':
            state.mode = (state.mode & ~0o7777) | (op.mode & 0o7777);
            state.ctime = op.at;
            return state;
        case 'chown':
            state.uid = op.uid ?? state.uid;
            state.gid = op.gid ?? state.gid;
            state.mode = chownedMode(state.mode, { uid: op.by });
            state.ctime = op.at;
            return state;
        case 'utimes':
            state.atime = timeAt(op.atime, state.atime, op.at);
            state.mtime = timeAt(op.mtime, state.mtime, op.at);
            state.ctime = op.at;
            return state;
    }
}
/** `ops` folded over a copy of `baseline`, in order: what the inode is with them pending. */
export function foldOps(baseline, ops) {
    let state = copyState(baseline);
    for (let i = 0; i < ops.length; i++)
        state = applyOp(state, ops[i]);
    return state;
}
