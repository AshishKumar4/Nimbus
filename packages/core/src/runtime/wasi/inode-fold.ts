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
import { chownedMode, timeAt } from '../../vfs/posix-access.js';
import { bytesView, mathMax, typedArrayFill, typedArraySet, Uint8ArrayConstructor } from '../../_shared/primordials.js';

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
export type InodeOp =
  | { readonly kind: 'write'; readonly offset: number; readonly data: Uint8Array; readonly at: number }
  | { readonly kind: 'append'; readonly data: Uint8Array; readonly at: number }
  | { readonly kind: 'truncate'; readonly size: number; readonly at: number }
  | { readonly kind: 'chmod'; readonly mode: number; readonly at: number }
  /** A side null is kept. A chown by anyone but root clears the set-id bits (chownedMode). */
  | { readonly kind: 'chown'; readonly uid: number | null; readonly gid: number | null; readonly by: number; readonly at: number }
  | { readonly kind: 'utimes'; readonly atime: FsTime; readonly mtime: FsTime; readonly at: number };

/**
 * A private copy of the first `length` of `bytes`: a plain array no one else
 * holds, whatever `bytes` is (a Buffer's slice is a view of it, not a copy).
 */
export function owned(bytes: Uint8Array, length = bytes.length): Uint8Array {
  const copy = new Uint8ArrayConstructor(length);
  typedArraySet(copy, length === bytes.length ? bytes : bytesView(bytes, 0, length));
  return copy;
}

/** A copy of `state` that folding into does not change `state`. */
export function copyState(state: InodeState): InodeState {
  return { ...state, bytes: state.bytes === null ? null : owned(state.bytes, state.size) };
}

/** Room for `size` bytes in `state`'s buffer, its first `state.size` kept, the rest zero. */
function grown(state: InodeState, size: number): Uint8Array {
  const bytes = state.bytes!;
  if (size <= bytes.length) return bytes;
  const next = new Uint8ArrayConstructor(mathMax(size, bytes.length * 2, 4096));
  typedArraySet(next, state.size === bytes.length ? bytes : bytesView(bytes, 0, state.size));
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
export function applyOp(state: InodeState, op: InodeOp): InodeState {
  switch (op.kind) {
    case 'write':
    case 'append': {
      if (op.data.length === 0) return state;
      const offset = op.kind === 'append' ? state.size : op.offset;
      const end = offset + op.data.length;
      if (state.bytes !== null) {
        const bytes = grown(state, end);
        if (offset > state.size) typedArrayFill(bytes, 0, state.size, offset);
        typedArraySet(bytes, op.data, offset);
        state.bytes = bytes;
      }
      state.size = mathMax(state.size, end);
      state.mtime = state.ctime = op.at;
      return state;
    }
    case 'truncate': {
      if (op.size === 0) state.bytes = new Uint8ArrayConstructor(0);
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
export function foldOps(baseline: InodeState, ops: readonly InodeOp[]): InodeState {
  let state = copyState(baseline);
  for (let i = 0; i < ops.length; i++) state = applyOp(state, ops[i]!);
  return state;
}
