/**
 * git/pack/history.ts — a clone's history, fetched in self-contained pieces
 * after its worktree: all of it for a full clone, its N commits for a
 * --depth N clone (N > 1: the older commits' blobs the worktree's batches
 * did not fetch).
 *
 *   commits  every commit, no trees or blobs (filter tree:0); their root
 *            trees listed in pack order (newest first: neighbours share
 *            most of their trees)
 *   trees    the root trees of a run of commits with everything below them
 *            but blobs (filter blob:none), in runs of COMMITS_PER_CHUNK;
 *            each blob met is listed with its basename
 *   plan     the listed blobs, less those the worktree's batches fetched,
 *            once each, sorted by basename and cut into batches: a file's
 *            versions and its namesakes elsewhere travel together, so the
 *            server deltifies them as it does in one pack
 *   blobs    each batch, by id
 *
 * Every piece is its own request, so every pack is self-contained and is
 * resolved with a bounded cache; one that runs past an invocation's budget
 * is stored whole and resumed from its bytes (clone.ts resumePack). Measured
 * on react (2026-10-05, against GitHub): 137.66 MB in 12 requests, where git
 * clone fetches 137.16 MB in 3.
 */
import { decodeBatch, parseTree, MODE_GITLINK, MODE_TREE } from './plan.js';
import { OID_BYTES, oidToHex, PackFormatError } from './format.js';
import { STAGE_DIR, commitTree, concat, join, readRange, resumePack, settledBefore, TagWatch, storePackResumable, } from './clone.js';
import { requestPack } from './upload-pack.js';
/** Root trees per trees request. */
export const COMMITS_PER_CHUNK = 5_000;
/**
 * Blobs per blobs request. Small enough that a batch's pack mostly fits the
 * window of stored bytes kept readable, so evicted bases are re-inflated from
 * memory rather than read back over RPC: live, react's 25,000-blob batches
 * (packs to 52 MB) spent most of a 348 s clone in base reads and resumes.
 */
export const BLOBS_PER_HISTORY_BATCH = 10_000;
/** History packs are resolved with this cache, and this many stored bytes kept readable. */
const HISTORY_CACHE_BYTES = 8 * 1024 * 1024;
const HISTORY_RECENT_BYTES = 24 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function transport(context) {
    return { url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress };
}
/** Collects one invocation's list records and writes them as one staged file. */
class ListWriter {
    parts = [];
    size = 0;
    add(bytes) {
        this.parts.push(bytes);
        this.size += bytes.byteLength;
    }
    async write(writer, name) {
        if (this.size === 0)
            return [];
        const bytes = this.size;
        await writer.file(STAGE_DIR + '/' + name, 0o644, concat(this.parts));
        return [{ name, bytes }];
    }
}
/** What a kind of piece records as its objects resolve. */
function lister(kind, list) {
    if (kind === 'commits') {
        return (object) => {
            if (object.type === 'commit')
                list.add(hexBytes(commitTree(object.data, oidToHex(object.oid))));
        };
    }
    if (kind === 'trees') {
        // Within one piece each blob is listed once; across pieces the plan dedupes.
        const seen = new Set();
        return (object) => {
            if (object.type !== 'tree')
                return;
            for (const entry of parseTree(object.data)) {
                if (entry.mode === MODE_TREE || entry.mode === MODE_GITLINK)
                    continue;
                const oid = object.data.subarray(entry.oidAt, entry.oidAt + OID_BYTES);
                const hex = oidToHex(oid);
                if (seen.has(hex))
                    continue;
                seen.add(hex);
                const name = encoder.encode(entry.name);
                const record = new Uint8Array(OID_BYTES + 2 + name.byteLength);
                record.set(oid);
                new DataView(record.buffer).setUint16(OID_BYTES, name.byteLength);
                record.set(name, OID_BYTES + 2);
                list.add(record);
            }
        };
    }
    return undefined;
}
function hexBytes(hex) {
    const out = new Uint8Array(OID_BYTES);
    for (let i = 0; i < OID_BYTES; i++)
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}
async function settle(writer, kind, stored, list, listName, watch) {
    const lists = await list.write(writer, listName);
    await writer.flush();
    const tagsFound = [...watch.found];
    if ('pending' in stored)
        return { kind, pack: null, pending: stored.pending, lists, tagsFound };
    return { kind, pack: stored.summary, pending: null, lists, tagsFound };
}
/** What a piece records as its objects resolve, and which of the clone's tags' ids it meets. */
function watcher(kind, list, watch) {
    const listed = lister(kind, list);
    return (object) => {
        watch.see(object.type, object.oid);
        return listed?.(object);
    };
}
/** One piece of history: its request, its pack, its list. */
export async function historyStep(context, request) {
    const writer = context.writer();
    writer.setPin(context.marker.path, context.marker.text, true);
    let wants;
    let filter;
    let depth;
    if (request.kind === 'commits') {
        if (request.head === undefined)
            throw new PackFormatError('a commits piece needs the head');
        wants = [request.head];
        filter = 'tree:0';
        depth = request.depth;
    }
    else {
        const source = request.source;
        if (source === undefined)
            throw new PackFormatError('a ' + request.kind + ' piece needs its source');
        const bytes = await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/' + source.name), source.offset ?? 0, source.length ?? source.bytes);
        const unique = new Set();
        for (let at = 0; at < bytes.byteLength; at += OID_BYTES)
            unique.add(oidToHex(bytes, at));
        wants = [...unique];
        filter = request.kind === 'trees' ? 'blob:none' : undefined;
    }
    const response = await requestPack(transport(context), new Set(request.capabilities), { wants, filter, ...(depth !== undefined ? { depth } : {}) });
    if (response.pack === null)
        throw new PackFormatError('the server sent no pack for history piece ' + request.piece);
    const list = new ListWriter();
    const watch = new TagWatch(request.tagInterest ?? []);
    const stored = await storePackResumable(context, writer, response.pack, 'tmp_pack_' + request.jobId + '_' + request.piece, {
        cacheBytes: HISTORY_CACHE_BYTES,
        recentBytes: HISTORY_RECENT_BYTES,
        budgetUnits: request.budgetUnits,
        onObject: watcher(request.kind, list, watch),
    });
    return await settle(writer, request.kind, stored, list, 'list-' + request.piece + '-0', watch);
}
/** A piece whose decoding stopped at the budget, continued from its stored pack. */
export async function historyResume(context, request) {
    // A resumed pack cannot be fetched again: a step run again after its
    // answer was lost finds the outcome it recorded before naming its pack.
    const recordName = 'settled-' + request.pending.tmpName;
    const settled = await settledBefore(context, request.pending.tmpName, recordName);
    if (settled !== null) {
        const extra = settled.extra;
        return { kind: request.kind, pack: settled.summary, pending: null, lists: extra.lists, tagsFound: extra.tagsFound };
    }
    const writer = context.writer();
    writer.setPin(context.marker.path, context.marker.text, true);
    const list = new ListWriter();
    const watch = new TagWatch(request.tagInterest ?? []);
    const listName = 'list-' + request.piece + '-' + request.part;
    let lists = [];
    const stored = await resumePack(context, writer, request.pending, {
        cacheBytes: HISTORY_CACHE_BYTES,
        recentBytes: HISTORY_RECENT_BYTES,
        budgetUnits: request.budgetUnits,
        onObject: watcher(request.kind, list, watch),
        record: {
            name: recordName,
            publish: async () => ({ lists: (lists = await list.write(writer, listName)), tagsFound: [...watch.found] }),
        },
    });
    if ('pending' in stored)
        return await settle(writer, request.kind, stored, list, listName, watch);
    return { kind: request.kind, pack: stored.summary, pending: null, lists, tagsFound: [...watch.found] };
}
/** An open-addressing set of 20-byte ids, each with a basename: the plan's only large structure. */
class BlobTable {
    oids = new Uint8Array(OID_BYTES * 1024);
    names = new Uint32Array(1024);
    /** Ids present already (the worktree's): kept out of every batch. */
    present = new Uint8Array(1024);
    count = 0;
    slots = new Int32Array(1 << 12).fill(-1);
    nameIds = new Map();
    nameList = [];
    add(oid, at, name) {
        const index = this.find(oid, at);
        if (index >= 0)
            return;
        if ((this.count + 1) * 2 > this.slots.length)
            this.rehash(this.slots.length * 2);
        if (this.count === this.names.length)
            this.grow();
        const n = this.count++;
        this.oids.set(oid.subarray(at, at + OID_BYTES), n * OID_BYTES);
        if (name === null) {
            this.present[n] = 1;
        }
        else {
            let id = this.nameIds.get(name);
            if (id === undefined) {
                id = this.nameList.length;
                this.nameIds.set(name, id);
                this.nameList.push(name);
            }
            this.names[n] = id;
        }
        this.slots[this.slotOf(oid, at)] = n;
    }
    hash(oid, at) {
        return ((oid[at] << 24) | (oid[at + 1] << 16) | (oid[at + 2] << 8) | oid[at + 3]) >>> 0;
    }
    slotOf(oid, at) {
        const mask = this.slots.length - 1;
        let slot = this.hash(oid, at) & mask;
        while (this.slots[slot] >= 0 && !this.same(this.slots[slot], oid, at))
            slot = (slot + 1) & mask;
        return slot;
    }
    find(oid, at) {
        return this.slots[this.slotOf(oid, at)];
    }
    same(index, oid, at) {
        const base = index * OID_BYTES;
        for (let i = 0; i < OID_BYTES; i++)
            if (this.oids[base + i] !== oid[at + i])
                return false;
        return true;
    }
    grow() {
        const capacity = this.names.length * 2;
        const oids = new Uint8Array(capacity * OID_BYTES);
        oids.set(this.oids);
        this.oids = oids;
        const names = new Uint32Array(capacity);
        names.set(this.names);
        this.names = names;
        const present = new Uint8Array(capacity);
        present.set(this.present);
        this.present = present;
    }
    rehash(size) {
        this.slots = new Int32Array(size).fill(-1);
        for (let n = 0; n < this.count; n++)
            this.slots[this.slotOf(this.oids, n * OID_BYTES)] = n;
    }
}
/**
 * The blobs batches: every listed blob not already present, once, sorted by
 * basename. `present` are the worktree batch files (plan.ts encodeBatch).
 */
export async function historyPlan(context, request) {
    const table = new BlobTable();
    for (const file of request.present) {
        const bytes = await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/' + file.name), 0, file.bytes);
        for (const oid of decodeBatch(bytes).keys())
            table.add(hexBytes(oid), 0, null);
    }
    for (const file of request.lists) {
        const bytes = await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/' + file.name), 0, file.bytes);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let at = 0; at < bytes.byteLength;) {
            const length = view.getUint16(at + OID_BYTES);
            table.add(bytes, at, decoder.decode(bytes.subarray(at + OID_BYTES + 2, at + OID_BYTES + 2 + length)));
            at += OID_BYTES + 2 + length;
        }
    }
    // Basenames in byte order; ids within one basename in table order.
    const rank = new Uint32Array(table.nameList.length);
    table.nameList.map((name, id) => ({ name, id }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .forEach(({ id }, position) => { rank[id] = position; });
    const order = [];
    for (let n = 0; n < table.count; n++)
        if (table.present[n] === 0)
            order.push(n);
    order.sort((a, b) => rank[table.names[a]] - rank[table.names[b]] || a - b);
    const perBatch = request.blobsPerBatch ?? BLOBS_PER_HISTORY_BATCH;
    const writer = context.writer();
    writer.setPin(context.marker.path, context.marker.text, true);
    const batches = [];
    for (let start = 0; start < order.length; start += perBatch) {
        const slice = order.slice(start, start + perBatch);
        const bytes = new Uint8Array(slice.length * OID_BYTES);
        slice.forEach((n, i) => bytes.set(table.oids.subarray(n * OID_BYTES, (n + 1) * OID_BYTES), i * OID_BYTES));
        const name = 'history-batch-' + batches.length;
        batches.push({ name, bytes: bytes.byteLength });
        await writer.file(STAGE_DIR + '/' + name, 0o644, bytes);
    }
    await writer.flush();
    return { batches, blobs: order.length, names: table.nameList.length };
}
/** Root-tree slices of the commits lists, COMMITS_PER_CHUNK at a time. */
export function treeSlices(lists, commitsPerChunk = COMMITS_PER_CHUNK) {
    const slices = [];
    const step = commitsPerChunk * OID_BYTES;
    for (const list of lists) {
        for (let offset = 0; offset < list.bytes; offset += step) {
            slices.push({ ...list, offset, length: Math.min(step, list.bytes - offset) });
        }
    }
    return slices;
}
