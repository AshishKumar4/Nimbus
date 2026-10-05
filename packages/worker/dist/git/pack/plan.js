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
 */
import { OID_BYTES, PackFormatError, oidToHex } from './format.js';
export const MODE_TREE = 0o040000;
export const MODE_FILE = 0o100644;
export const MODE_EXECUTABLE = 0o100755;
export const MODE_SYMLINK = 0o120000;
export const MODE_GITLINK = 0o160000;
const utf8 = new TextDecoder('utf-8', { fatal: false });
const utf8Encoder = new TextEncoder();
/** A tree object's entries, in the tree's own order. */
export function parseTree(tree) {
    const entries = [];
    let p = 0;
    while (p < tree.byteLength) {
        let mode = 0;
        while (p < tree.byteLength && tree[p] !== 0x20) {
            const digit = tree[p++] - 0x30;
            if (digit < 0 || digit > 7)
                throw new PackFormatError('tree entry mode is not octal');
            mode = mode * 8 + digit;
        }
        const nameStart = ++p;
        while (p < tree.byteLength && tree[p] !== 0)
            p++;
        if (p + 1 + OID_BYTES > tree.byteLength)
            throw new PackFormatError('tree entry is truncated');
        const name = utf8.decode(tree.subarray(nameStart, p));
        if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name === '.git') {
            throw new PackFormatError('tree entry name ' + JSON.stringify(name) + ' is not a path component');
        }
        entries.push({ mode, name, oidAt: p + 1 });
        p += 1 + OID_BYTES;
    }
    return entries;
}
/** Growable columns. */
class Columns {
    oids = new Uint8Array(OID_BYTES * 1024);
    modes = new Uint32Array(1024);
    pathStarts = new Uint32Array(1025);
    pathBytes = new Uint8Array(64 * 1024);
    count = 0;
    add(path, mode, oid, oidAt) {
        if (this.count === this.modes.length) {
            const capacity = this.count * 2;
            this.oids = grow(this.oids, capacity * OID_BYTES);
            const modes = new Uint32Array(capacity);
            modes.set(this.modes);
            this.modes = modes;
            const starts = new Uint32Array(capacity + 1);
            starts.set(this.pathStarts);
            this.pathStarts = starts;
        }
        const start = this.pathStarts[this.count];
        if (start + path.byteLength > this.pathBytes.byteLength) {
            this.pathBytes = grow(this.pathBytes, Math.max(this.pathBytes.byteLength * 2, start + path.byteLength));
        }
        this.pathBytes.set(path, start);
        this.oids.set(oid.subarray(oidAt, oidAt + OID_BYTES), this.count * OID_BYTES);
        this.modes[this.count] = mode;
        this.pathStarts[++this.count] = start + path.byteLength;
    }
}
function grow(bytes, length) {
    const grown = new Uint8Array(length);
    grown.set(bytes);
    return grown;
}
export class CheckoutPlan {
    count;
    oids;
    modes;
    pathStarts;
    pathBytes;
    constructor(count, oids, modes, pathStarts, pathBytes) {
        this.count = count;
        this.oids = oids;
        this.modes = modes;
        this.pathStarts = pathStarts;
        this.pathBytes = pathBytes;
    }
    /** Walk `rootTree`'s tree, each subtree read with `tree(oid)`; a path is kept when `keep` says so. */
    static fromTrees(rootTree, tree, keep = () => true) {
        const columns = new Columns();
        const stack = [
            { data: rootTree, entries: parseTree(rootTree), next: 0, prefix: '' },
        ];
        while (stack.length > 0) {
            const frame = stack[stack.length - 1];
            if (frame.next === frame.entries.length) {
                stack.pop();
                continue;
            }
            const entry = frame.entries[frame.next++];
            const path = frame.prefix + entry.name;
            if (entry.mode === MODE_TREE) {
                if (!keep(path, entry.mode))
                    continue;
                const data = tree(frame.data, entry.oidAt);
                stack.push({ data, entries: parseTree(data), next: 0, prefix: path + '/' });
                continue;
            }
            if (entry.mode !== MODE_FILE && entry.mode !== MODE_EXECUTABLE && entry.mode !== MODE_SYMLINK &&
                entry.mode !== MODE_GITLINK && entry.mode !== 0o100664) {
                throw new PackFormatError('tree entry ' + path + ' has mode ' + entry.mode.toString(8));
            }
            if (!keep(path, entry.mode))
                continue;
            // git reads the old group-writable mode as a plain file.
            columns.add(utf8Encoder.encode(path), entry.mode === 0o100664 ? MODE_FILE : entry.mode, frame.data, entry.oidAt);
        }
        return new CheckoutPlan(columns.count, columns.oids.slice(0, columns.count * OID_BYTES), columns.modes.slice(0, columns.count), columns.pathStarts.slice(0, columns.count + 1), columns.pathBytes.slice(0, columns.pathStarts[columns.count]));
    }
    /** Bytes held, for the memory account. */
    get byteLength() {
        return this.oids.byteLength + this.modes.byteLength + this.pathStarts.byteLength + this.pathBytes.byteLength;
    }
    mode(index) {
        return this.modes[index];
    }
    path(index) {
        return utf8.decode(this.pathBytes.subarray(this.pathStarts[index], this.pathStarts[index + 1]));
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
     * Gitlinks name commits of another repository and are never fetched.
     */
    blobPaths() {
        const blobs = new Map();
        for (let i = 0; i < this.count; i++) {
            if (this.modes[i] === MODE_GITLINK)
                continue;
            const hex = this.oidHex(i);
            const paths = blobs.get(hex);
            if (paths)
                paths.push(i);
            else
                blobs.set(hex, [i]);
        }
        return blobs;
    }
    /** The distinct blobs not in `present`, split into at most `batches` runs (see the class comment). */
    batches(batches, present = new Set()) {
        const blobs = [...this.blobPaths()].filter(([oid]) => !present.has(oid));
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
 * mode and repo-relative path. [oid 20][paths u16]([mode u32][length u16][utf-8])*
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
        out.set(plan.oid(blob.entries[0]), p);
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
            paths.push({ mode, path: utf8.decode(bytes.subarray(p + 6, p + 6 + length)) });
            p += 6 + length;
        }
        blobs.set(oid, paths);
    }
    return blobs;
}
