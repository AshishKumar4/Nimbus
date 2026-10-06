/**
 * git/worktree/pairs.ts — a diff's changed paths in columns, git's diff
 * queue without an object per pair.
 *
 * Each pair is its path (once: both sides of a diff-files or diff-index pair
 * share it), each side's object id and mode, which sides it has, and whether
 * its second side is the worktree's. With every file of a 96,000-file tree
 * changed, the queue as objects held about 70 MiB; as columns it is the
 * paths plus 53 bytes a pair. A pair becomes an object only while it is
 * printed, or when rename detection needs it (additions and deletions).
 */
import { oidFromHex, oidToHex } from '../pack/format.js';
import { growBytes } from '../pack/plan.js';
import { compareBytes, decodePath } from './dircache.js';
const OID_BYTES = 20;
const ONE = 1;
const TWO = 2;
const TWO_IN_WORKTREE = 4;
const encoder = new TextEncoder();
export class PairList {
    count = 0;
    pathStarts = new Uint32Array(1025);
    paths = new Uint8Array(64 * 1024);
    /** Two ids a pair: its first side's, then its second's. */
    oids = new Uint8Array(2 * OID_BYTES * 1024);
    modes = new Uint32Array(2 * 1024);
    flags = new Uint8Array(1024);
    /** Pairs were added in path order. */
    ordered = true;
    /** Add the pair at `path`, unless both sides are there and the same. */
    add(path, one, two) {
        if (!one && !two)
            return;
        if (one && two && one.oid === two.oid && one.mode === two.mode)
            return;
        const name = encoder.encode(path);
        const k = this.count;
        if (k === this.flags.length) {
            const capacity = k * 2;
            this.oids = growBytes(this.oids, capacity * 2 * OID_BYTES);
            this.flags = growBytes(this.flags, capacity);
            const modes = new Uint32Array(capacity * 2);
            modes.set(this.modes);
            this.modes = modes;
            const starts = new Uint32Array(capacity + 1);
            starts.set(this.pathStarts);
            this.pathStarts = starts;
        }
        const start = this.pathStarts[k];
        if (start + name.length > this.paths.length)
            this.paths = growBytes(this.paths, Math.max(this.paths.length * 2, start + name.length));
        this.paths.set(name, start);
        this.pathStarts[k + 1] = start + name.length;
        if (k > 0 && compareBytes(this.pathBytes(k - 1), name) > 0)
            this.ordered = false;
        let flags = 0;
        if (one) {
            flags |= ONE;
            this.oids.set(oidFromHex(one.oid), 2 * k * OID_BYTES);
            this.modes[2 * k] = one.mode;
        }
        if (two) {
            flags |= TWO | (two.worktree ? TWO_IN_WORKTREE : 0);
            this.oids.set(oidFromHex(two.oid), (2 * k + 1) * OID_BYTES);
            this.modes[2 * k + 1] = two.mode;
        }
        this.flags[k] = flags;
        this.count++;
    }
    pathBytes(k) {
        return this.paths.subarray(this.pathStarts[k], this.pathStarts[k + 1]);
    }
    /** The pairs' numbers in path order. */
    order() {
        const order = new Uint32Array(this.count);
        for (let k = 0; k < this.count; k++)
            order[k] = k;
        if (!this.ordered)
            order.sort((a, b) => compareBytes(this.pathBytes(a), this.pathBytes(b)));
        return order;
    }
    /** Both sides there: a modification, which rename detection passes over. */
    modified(k) {
        return (this.flags[k] & (ONE | TWO)) === (ONE | TWO);
    }
    /** The ids a diff reads from the object store: every first side, and second sides not in the worktree. */
    *storeOids() {
        for (let k = 0; k < this.count; k++) {
            if (this.flags[k] & ONE)
                yield oidToHex(this.oids, 2 * k * OID_BYTES);
            if ((this.flags[k] & (TWO | TWO_IN_WORKTREE)) === TWO)
                yield oidToHex(this.oids, (2 * k + 1) * OID_BYTES);
        }
    }
    pair(k) {
        const path = decodePath(this.pathBytes(k));
        const flags = this.flags[k];
        return {
            one: flags & ONE ? { path, oid: oidToHex(this.oids, 2 * k * OID_BYTES), mode: this.modes[2 * k], worktree: false } : null,
            two: flags & TWO
                ? { path, oid: oidToHex(this.oids, (2 * k + 1) * OID_BYTES), mode: this.modes[2 * k + 1], worktree: (flags & TWO_IN_WORKTREE) !== 0 }
                : null,
        };
    }
}
