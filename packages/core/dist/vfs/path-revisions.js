/**
 * path-revisions.ts — SqliteVFS's per-path revisions: subtree watermarks
 * held for directories only, under a byte budget.
 *
 * lean/Nimbus/Vfs/RevisionFloor.lean models this unit one to one: `stamp` is
 * the model's `walkAll` (its walk and `stampOne`) followed by the drops the
 * budget takes (RevisionFloorCases' `dropWhileOver`), `dropThrough` is
 * `drop`, and `report` is `revision`. The theorems there are what the rules
 * below rely on.
 *
 * Every mutation writes the generation of each path it mutates into SQLite,
 * as the path's row or its tombstone, so a path's own last change is durable
 * and needs nothing in memory. What one read of SQLite cannot answer is the
 * subtree, and that is the stamp: a mutation stamps each directory above the
 * mutated path with its revision, and the mutated path itself only if it
 * holds a stamp already. So a written or removed file costs no memory, and
 * there is one stamp per directory something was mutated under.
 *
 * A path reports its stamp; else, for a file or symlink row, the row's
 * generation (so an untouched file keeps its revision across restarts);
 * else, for a directory or a missing path, the later of the floor and the
 * generation of its row or tombstone. The floor starts at the clock at open
 * and rises to cover every stamp dropped and every tombstone pruned.
 *
 * The invariant (RevisionFloor.lean, Inv): every stamp is above the floor,
 * at most the clock, and at or below the stamp of each directory above it.
 * The newest mutation at or under a path is at or below its stamp; without
 * one, at or below its row's generation if it is a file, else the later of
 * the floor and its own generation. Each directory strictly above a path
 * holds a stamp at or above that path's row or own generation, unless the
 * floor covers it. So no path reports below the last mutation at or under
 * it, none above the clock, and a directory never below anything under it.
 *
 * Bounded by bytes. Past the budget the oldest quarter goes at once, and the
 * floor rises to the newest revision dropped. A report must never fall below
 * the path's last change: a resident row, a write receipt or an expected
 * revision compared against a smaller number would be vouched for by a
 * revision older than that change. The floor only rises, so a directory
 * whose stamp was dropped can report a higher revision with nothing under it
 * changed, which costs its readers a refetch, never a stale byte.
 */
export class PathRevisions {
    budget;
    stamps = new Map();
    bytes = 0;
    _floor;
    constructor(budget, floor) {
        this.budget = budget;
        this._floor = floor;
    }
    /** At or above the last change of every path without a stamp that is not a file. */
    get floor() {
        return this._floor;
    }
    stats() {
        return { paths: this.stamps.size, bytes: this.bytes, maxBytes: this.budget, floor: this._floor };
    }
    /**
     * Stamp every directory above each storage key at `rev`, and each key that
     * holds a stamp already: a stamp answers for its path before the path's row
     * does, so it moves too. A walk stops at a directory this call has already
     * stamped, since every directory above it was stamped with it. Then drop
     * the oldest stamps while over budget.
     */
    stamp(keys, rev) {
        for (const key of keys) {
            for (let p = parentKey(key); p !== ''; p = parentKey(p)) {
                const stamped = this.stamps.get(p);
                if (stamped === rev)
                    break;
                if (stamped === undefined)
                    this.bytes += entryBytes(p);
                this.stamps.set(p, rev);
            }
            if (this.stamps.has(key))
                this.stamps.set(key, rev);
        }
        // A quarter at a time, so the sort is paid once per quarter of the
        // budget, not once per mutation.
        while (this.bytes > this.budget) {
            const sorted = Float64Array.from(this.stamps.values()).sort();
            this.dropThrough(sorted[Math.floor(sorted.length / 4)]);
        }
    }
    /**
     * Drop every stamp at or below `cutoff` and raise the floor to it. A stamp
     * left at or below the floor would report its directory below a missing
     * path under it, which reports the floor. Everything at or below one
     * revision goes together, and a directory's stamp is never older than one
     * under it, so a dropped directory takes every stamp under it along.
     */
    dropThrough(cutoff) {
        for (const [path, stamped] of this.stamps) {
            if (stamped > cutoff)
                continue;
            this.stamps.delete(path);
            this.bytes -= entryBytes(path);
        }
        this._floor = Math.max(this._floor, cutoff);
    }
    /**
     * The revision of `key`, not the root: its stamp; else what SQLite holds
     * for it, the generation `gen` of its row or tombstone (0 for neither),
     * the row's own for a file's or symlink's (`file`) and otherwise no less
     * than the floor. Never above `clock`, so a row written by a transaction
     * not yet published reports the clock.
     */
    report(key, gen, file, clock) {
        const stamped = this.stamps.get(key);
        if (stamped !== undefined)
            return stamped;
        const own = Math.min(gen, clock);
        return file ? own : Math.max(this._floor, own);
    }
}
function parentKey(key) {
    const slash = key.lastIndexOf('/');
    return slash === -1 ? '' : key.slice(0, slash);
}
/** UTF-16 payload plus a flat allowance for the entry object itself. */
export function entryBytes(path) {
    return path.length * 2 + 48;
}
