/**
 * git/pack/plan.ts — what a checkout writes, held compactly.
 *
 * A checkout plan is the commit's tree flattened: every path with its mode
 * and object id, in the order a checkout walks them. It is held as columns
 * (ids in one Uint8Array, modes in a Uint32Array, paths in one UTF-8 arena
 * with offsets), about 26 bytes per entry plus the path itself: Linux's
 * 96,053 entries in ~6 MB, where an array of objects would take several
 * times that.
 *
 * Batches split the plan's distinct blobs into contiguous runs, so each
 * batch is a set of nearby paths (the server deltifies within a request,
 * and nearby paths are the similar ones) and every path of a blob lands in
 * the blob's batch.
 *
 * A sparse checkout's plan still holds every path (the index lists them
 * all); a path outside its cone is marked skip-worktree and never written.
 */
import { nameDec } from '@nimbus-sh/core/_shared/bytes.js';
import { OID_BYTES, PackFormatError, oidFromHex, oidToHex } from './format.js';
import { TreeEntries } from './tree-object.js';
import { DEFAULT_PATH_PROTECTION, verifyPath } from '../worktree/verify-path.js';
export const MODE_TREE = 0o040000;
export const MODE_FILE = 0o100644;
export const MODE_EXECUTABLE = 0o100755;
export const MODE_SYMLINK = 0o120000;
export const MODE_GITLINK = 0o160000;
const utf8Encoder = new TextEncoder();
/** Growable columns. */
class Columns {
    oids = new Uint8Array(OID_BYTES * 1024);
    modes = new Uint32Array(1024);
    skips = new Uint8Array(1024);
    pathStarts = new Uint32Array(1025);
    pathBytes = new Uint8Array(64 * 1024);
    count = 0;
    /** An entry at path `prefix` + `name`: its bytes as the trees hold them. */
    add(prefix, name, mode, oid, oidAt, skip) {
        if (this.count === this.modes.length) {
            const capacity = this.count * 2;
            this.oids = growBytes(this.oids, capacity * OID_BYTES);
            const modes = new Uint32Array(capacity);
            modes.set(this.modes);
            this.modes = modes;
            this.skips = growBytes(this.skips, capacity);
            const starts = new Uint32Array(capacity + 1);
            starts.set(this.pathStarts);
            this.pathStarts = starts;
        }
        const start = this.pathStarts[this.count];
        const end = start + prefix.byteLength + name.byteLength;
        if (end > this.pathBytes.byteLength)
            this.pathBytes = growBytes(this.pathBytes, Math.max(this.pathBytes.byteLength * 2, end));
        this.pathBytes.set(prefix, start);
        this.pathBytes.set(name, start + prefix.byteLength);
        this.oids.set(oid.subarray(oidAt, oidAt + OID_BYTES), this.count * OID_BYTES);
        this.modes[this.count] = mode;
        this.skips[this.count] = skip ? 1 : 0;
        this.pathStarts[++this.count] = end;
    }
}
/** `bytes` copied into a longer buffer. */
export function growBytes(bytes, length) {
    const grown = new Uint8Array(length);
    grown.set(bytes);
    return grown;
}
export class CheckoutPlan {
    count;
    oids;
    modes;
    skips;
    pathStarts;
    pathBytes;
    refused;
    constructor(count, oids, modes, 
    /** 1 for a skip-worktree entry (outside a sparse checkout's cone). */
    skips, pathStarts, pathBytes, 
    /** The first path git's verify_path refuses, or null: then the checkout fails and writes nothing. */
    refused) {
        this.count = count;
        this.oids = oids;
        this.modes = modes;
        this.skips = skips;
        this.pathStarts = pathStarts;
        this.pathBytes = pathBytes;
        this.refused = refused;
    }
    /**
     * Walk `rootTree`'s tree, each subtree read with `tree(oid)`. With
     * `sparse`, a path outside its cone is skip-worktree; every tree is still
     * walked, as the index holds every path. A path `protect`'s verify_path
     * refuses fails the checkout, as unpack_trees fails before it writes
     * anything: every entry is then left unwritten, and the first such path
     * named (a clone's checkout stops at it).
     */
    static fromTrees(rootTree, tree, sparse, protect = DEFAULT_PATH_PROTECTION) {
        const columns = new Columns();
        // verify_path goes component by component, so a name is verified once: a directory's refusal is every path's below it.
        const stack = [{ data: rootTree, entries: new TreeEntries(rootTree), prefix: '', prefixBytes: new Uint8Array(0), refusing: false }];
        let refused = null;
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            const entry = frame.entries;
            if (!entry.next()) {
                stack.pop();
                continue;
            }
            const raw = frame.data.subarray(entry.nameAt, entry.nameEnd);
            const name = nameDec.decode(raw);
            // A path's bytes are its name's as decoded: a name not UTF-8 is held as its replacement characters.
            const nameBytes = name.includes('\uFFFD') ? utf8Encoder.encode(name) : raw;
            if (entry.mode === MODE_TREE) {
                const data = tree(frame.data, entry.oidAt);
                const prefixBytes = new Uint8Array(frame.prefixBytes.byteLength + nameBytes.byteLength + 1);
                prefixBytes.set(frame.prefixBytes);
                prefixBytes.set(nameBytes, frame.prefixBytes.byteLength);
                prefixBytes[prefixBytes.byteLength - 1] = 0x2f;
                const refusing = frame.refusing || !verifyPath(name, MODE_TREE, protect);
                stack.push({ data, entries: new TreeEntries(data), prefix: frame.prefix + name + '/', prefixBytes, refusing });
                continue;
            }
            // A link's mode reaches every component (no .gitmodules above it): its whole path is verified.
            const refuses = entry.mode === MODE_SYMLINK ? !verifyPath(frame.prefix + name, MODE_SYMLINK, protect) : frame.refusing || !verifyPath(name, entry.mode, protect);
            if (refused === null && refuses)
                refused = frame.prefix + name;
            const skip = sparse !== undefined && !sparse.includes(frame.prefix + name);
            columns.add(frame.prefixBytes, nameBytes, entry.mode, frame.data, entry.oidAt, skip);
        }
        if (refused !== null)
            columns.skips.fill(1);
        return new CheckoutPlan(columns.count, columns.oids.slice(0, columns.count * OID_BYTES), columns.modes.slice(0, columns.count), columns.skips.slice(0, columns.count), columns.pathStarts.slice(0, columns.count + 1), columns.pathBytes.slice(0, columns.pathStarts[columns.count]), refused);
    }
    /** Bytes held, for the memory account. */
    get byteLength() {
        return this.oids.byteLength + this.modes.byteLength + this.skips.byteLength + this.pathStarts.byteLength + this.pathBytes.byteLength;
    }
    mode(index) {
        return this.modes[index];
    }
    /** Whether the entry is outside the sparse checkout: in the index, skip-worktree, not written. */
    skipWorktree(index) {
        return this.skips[index] === 1;
    }
    path(index) {
        return nameDec.decode(this.pathBytes.subarray(this.pathStarts[index], this.pathStarts[index + 1]));
    }
    pathBytesOf(index) {
        return this.pathBytes.subarray(this.pathStarts[index], this.pathStarts[index + 1]);
    }
    oidHex(index) {
        return oidToHex(this.oids, index * OID_BYTES);
    }
    oid(index) {
        return this.oids.subarray(index * OID_BYTES, (index + 1) * OID_BYTES);
    }
    /**
     * Each distinct blob, in walk order, and the entries it is checked out at.
     * Gitlinks name commits of another repository and are never fetched. A
     * skip-worktree entry is checked out nowhere; with `storeSkipped` a blob
     * only such entries name is kept, at no entries (fetched and stored, as a
     * clone that is not partial holds every object).
     */
    blobPaths(options = {}) {
        const blobs = new Map();
        for (let i = 0; i < this.count; i++) {
            if (this.modes[i] === MODE_GITLINK)
                continue;
            const skipped = this.skips[i] === 1;
            if (skipped && options.storeSkipped !== true)
                continue;
            const hex = this.oidHex(i);
            let paths = blobs.get(hex);
            if (paths === undefined)
                blobs.set(hex, (paths = []));
            if (!skipped)
                paths.push(i);
        }
        return blobs;
    }
    /** The distinct blobs not in `present`, split into at most `batches` runs (see the class comment). */
    batches(batches, present = new Set(), options = {}) {
        const blobs = [...this.blobPaths(options)].filter(([oid]) => !present.has(oid));
        const count = Math.max(1, Math.min(batches, blobs.length));
        const out = [];
        for (let k = 0; k < count; k++) {
            const slice = blobs.slice(Math.floor((k * blobs.length) / count), Math.floor(((k + 1) * blobs.length) / count));
            if (slice.length > 0)
                out.push({ index: k, blobs: slice.map(([oid, entries]) => ({ oid, entries })) });
        }
        return out;
    }
}
/**
 * A batch as one facet receives it: for each blob its id, then each path's
 * mode and repo-relative path (none: the blob is fetched and stored only).
 * [oid 20][paths u16]([mode u32][length u16][utf-8])*
 */
export function encodeBatch(plan, batch) {
    let size = 0;
    for (const blob of batch.blobs) {
        size += OID_BYTES + 2;
        for (const entry of blob.entries)
            size += 6 + plan.pathBytesOf(entry).byteLength;
    }
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let p = 0;
    for (const blob of batch.blobs) {
        if (blob.entries.length > 0xffff)
            throw new PackFormatError('blob ' + blob.oid + ' is checked out at more than 65535 paths');
        out.set(oidFromHex(blob.oid), p);
        p += OID_BYTES;
        view.setUint16(p, blob.entries.length);
        p += 2;
        for (const entry of blob.entries) {
            const path = plan.pathBytesOf(entry);
            view.setUint32(p, plan.mode(entry));
            view.setUint16(p + 4, path.byteLength);
            out.set(path, p + 6);
            p += 6 + path.byteLength;
        }
    }
    return out;
}
/** A batch's blobs, by hex id, each with the paths it is checked out at. */
export function decodeBatch(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const blobs = new Map();
    let p = 0;
    while (p < bytes.byteLength) {
        const oid = oidToHex(bytes, p);
        p += OID_BYTES;
        const count = view.getUint16(p);
        p += 2;
        const paths = [];
        for (let i = 0; i < count; i++) {
            const mode = view.getUint32(p);
            const length = view.getUint16(p + 4);
            paths.push({ mode, path: nameDec.decode(bytes.subarray(p + 6, p + 6 + length)) });
            p += 6 + length;
        }
        blobs.set(oid, paths);
    }
    return blobs;
}
