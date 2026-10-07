/**
 * git/pack/commit-graph.ts — a repository's commit-graph
 * (Documentation/gitformat-commit-graph.txt), byte for byte what git 2.53
 * writes for `git commit-graph write --reachable` (generation data v2): a
 * full clone's, written as it finishes, as a chain of one layer
 * (objects/info/commit-graphs/), so the layers a later fetch writes stack on
 * it as git's do.
 *
 *   header   "CGPH", version 1, hash version 1 (SHA-1), chunks, 0 base graphs
 *   table    each chunk's id and offset, then a zero id and the end offset
 *   OIDF     256 u32: commits whose first id byte is <= i
 *   OIDL     the commits' ids, ascending
 *   CDAT     per commit: root tree; first and second parent (their graph
 *            positions; GRAPH_PARENT_NONE; or, for an octopus, the EDGE index
 *            with GRAPH_EXTRA_EDGES_NEEDED); topological level << 2 with the
 *            committer date's bits 32-33, then its low 32 bits
 *   GDA2     per commit: corrected commit date minus committer date, or past
 *            2^31 - 1 the index of its 64-bit value in GDO2, with the top bit
 *   GDO2     those 64-bit offsets (only when there are any)
 *   EDGE     an octopus's third and later parents, the last one marked
 *            (only when there are any)
 *   trailer  SHA-1 of everything above: the layer's name
 *
 * A clone's commits piece records each commit as it resolves
 * (commitRecord): its id, root tree, committer date and parents, parsed as
 * git's parse_commit_buffer and parse_commit_date read them.
 */
import { createHash } from 'node:crypto';
import { OID_BYTES, PackFormatError } from './format.js';
const GRAPH_PARENT_NONE = 0x70000000;
const GRAPH_EXTRA_EDGES_NEEDED = 0x80000000;
const GRAPH_LAST_EDGE = 0x80000000;
const GENERATION_NUMBER_V1_MAX = 0x3fffffff;
const GENERATION_NUMBER_V2_OFFSET_MAX = (1n << 31n) - 1n;
const CORRECTED_COMMIT_DATE_OFFSET_OVERFLOW = 0x80000000;
const UINT64_MAX = (1n << 64n) - 1n;
/** Where a clone writes its graph: the chain file names its layers, oldest first. */
export const COMMIT_GRAPHS_DIR = '.git/objects/info/commit-graphs';
export const COMMIT_GRAPH_CHAIN = COMMIT_GRAPHS_DIR + '/commit-graph-chain';
const latin1 = new TextDecoder('latin1');
/**
 * A commit's record, from its id and its object's bytes: id, root tree,
 * committer date (u64), parent count (u16), parents. A commit git would
 * call bogus throws.
 */
export function commitRecord(oid, data) {
    // parse_commit_buffer: "tree <hex>\n", then "parent <hex>\n" lines.
    const TREE_LINE = 5 + 40;
    if (data.byteLength <= TREE_LINE + 1 || latin1.decode(data.subarray(0, 5)) !== 'tree ' || data[TREE_LINE] !== 0x0a) {
        throw new PackFormatError('bogus commit object ' + hex(oid));
    }
    const tree = hexBytes(data, 5, oid);
    const parents = [];
    const PARENT_LINE = 7 + 40;
    let at = TREE_LINE + 1;
    while (at + PARENT_LINE < data.byteLength && latin1.decode(data.subarray(at, at + 7)) === 'parent ') {
        if (data.byteLength <= at + PARENT_LINE + 1 || data[at + PARENT_LINE] !== 0x0a)
            throw new PackFormatError('bad parents in commit ' + hex(oid));
        parents.push(hexBytes(data, at + 7, oid));
        at += PARENT_LINE + 1;
    }
    const date = parseCommitDate(data, at);
    const record = new Uint8Array(2 * OID_BYTES + 8 + 2 + parents.length * OID_BYTES);
    const view = new DataView(record.buffer);
    record.set(oid, 0);
    record.set(tree, OID_BYTES);
    view.setBigUint64(2 * OID_BYTES, date);
    view.setUint16(2 * OID_BYTES + 8, parents.length);
    parents.forEach((parent, i) => record.set(parent, 2 * OID_BYTES + 10 + i * OID_BYTES));
    return record;
}
/** git's parse_commit_date (commit.c), from `at`, where its "author" line must start. */
function parseCommitDate(data, at) {
    const tail = data.byteLength;
    if (at + 6 >= tail || latin1.decode(data.subarray(at, at + 6)) !== 'author')
        return 0n;
    while (at < tail && data[at++] !== 0x0a)
        ;
    if (at + 9 >= tail || latin1.decode(data.subarray(at, at + 9)) !== 'committer')
        return 0n;
    const eol = data.indexOf(0x0a, at);
    if (eol === -1)
        return 0n;
    let date = eol;
    while (date > at && data[date - 1] !== 0x3e /* > */)
        date--;
    if (date === at)
        return 0n;
    while (date < eol && isSpace(data[date]))
        date++;
    if (!isDigit(data[date]) && data[date] !== 0x2d /* - */)
        return 0n;
    return parseTimestamp(data, date);
}
/** strtoumax(…, 10) as git's parse_timestamp is: a sign, digits, saturating at UINTMAX_MAX, a minus wrapping. */
function parseTimestamp(data, at) {
    let negative = false;
    if (data[at] === 0x2d || data[at] === 0x2b)
        negative = data[at++] === 0x2d;
    let value = 0n;
    let overflow = false;
    for (; at < data.byteLength && isDigit(data[at]); at++) {
        value = value * 10n + BigInt(data[at] - 0x30);
        if (value > UINT64_MAX)
            overflow = true;
    }
    if (overflow)
        return UINT64_MAX;
    return negative ? (UINT64_MAX + 1n - value) & UINT64_MAX : value;
}
const isDigit = (c) => c !== undefined && c >= 0x30 && c <= 0x39;
// C's isspace in the C locale.
const isSpace = (c) => c === 0x20 || (c !== undefined && c >= 0x09 && c <= 0x0d);
/** get_oid_hex: 40 hex digits, either case, from `at`. */
function hexBytes(data, at, oid) {
    const out = new Uint8Array(OID_BYTES);
    for (let i = 0; i < OID_BYTES; i++) {
        const high = hexValue(data[at + 2 * i]);
        const low = hexValue(data[at + 2 * i + 1]);
        if (high < 0 || low < 0)
            throw new PackFormatError('bad object id in commit ' + hex(oid));
        out[i] = (high << 4) | low;
    }
    return out;
}
function hexValue(c) {
    if (c >= 0x30 && c <= 0x39)
        return c - 0x30;
    if (c >= 0x61 && c <= 0x66)
        return c - 0x61 + 10;
    if (c >= 0x41 && c <= 0x46)
        return c - 0x41 + 10;
    return -1;
}
function hex(bytes) {
    let out = '';
    for (const byte of bytes)
        out += byte.toString(16).padStart(2, '0');
    return out;
}
/** The records of a staged list (commitRecord's, back to back), as views of its bytes. */
export function* commitRecords(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at < bytes.byteLength;) {
        if (at + 2 * OID_BYTES + 10 > bytes.byteLength)
            throw new PackFormatError('a commit record runs past its list');
        const length = 2 * OID_BYTES + 10 + view.getUint16(at + 2 * OID_BYTES + 8) * OID_BYTES;
        if (at + length > bytes.byteLength)
            throw new PackFormatError('a commit record runs past its list');
        yield bytes.subarray(at, at + length);
        at += length;
    }
}
/**
 * The graph's commits from their records (any order, each once): sorted by
 * id, each parent resolved to its position. A parent missing from the
 * records throws: `--reachable` takes every one.
 */
export function graphCommits(records) {
    const list = [...records];
    const count = list.length;
    const byId = list.map((record, i) => i).sort((a, b) => compareOid(list[a], 0, list[b], 0));
    const oids = new Uint8Array(count * OID_BYTES);
    byId.forEach((from, i) => oids.set(list[from].subarray(0, OID_BYTES), i * OID_BYTES));
    for (let i = 1; i < count; i++) {
        if (compareOid(oids, (i - 1) * OID_BYTES, oids, i * OID_BYTES) === 0)
            throw new PackFormatError('commit ' + hex(oids.subarray(i * OID_BYTES, (i + 1) * OID_BYTES)) + ' recorded twice');
    }
    const trees = new Uint8Array(count * OID_BYTES);
    const dates = new BigUint64Array(count);
    const parentStart = new Uint32Array(count + 1);
    let parentCount = 0;
    for (const record of list)
        parentCount += new DataView(record.buffer, record.byteOffset).getUint16(2 * OID_BYTES + 8);
    const parents = new Uint32Array(parentCount);
    let next = 0;
    byId.forEach((from, i) => {
        const record = list[from];
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
        trees.set(record.subarray(OID_BYTES, 2 * OID_BYTES), i * OID_BYTES);
        dates[i] = view.getBigUint64(2 * OID_BYTES);
        parentStart[i] = next;
        const n = view.getUint16(2 * OID_BYTES + 8);
        for (let p = 0; p < n; p++) {
            const at = 2 * OID_BYTES + 10 + p * OID_BYTES;
            const position = findOid(oids, count, record, at);
            if (position < 0)
                throw new PackFormatError('missing parent ' + hex(record.subarray(at, at + OID_BYTES)) + ' for commit ' + hex(record.subarray(0, OID_BYTES)));
            parents[next++] = position;
        }
    });
    parentStart[count] = next;
    return { count, oids, trees, dates, parentStart, parents };
}
function compareOid(a, aAt, b, bAt) {
    for (let i = 0; i < OID_BYTES; i++) {
        const d = a[aAt + i] - b[bAt + i];
        if (d !== 0)
            return d;
    }
    return 0;
}
function findOid(oids, count, key, at) {
    let lo = 0;
    let hi = count;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const d = compareOid(oids, mid * OID_BYTES, key, at);
        if (d === 0)
            return mid;
        if (d < 0)
            lo = mid + 1;
        else
            hi = mid;
    }
    return -1;
}
/**
 * Each commit's topological level and corrected commit date, as git's
 * compute_generation_from_max takes them from its parents': a commit after
 * every one of its parents (an iterative walk: a history is deeper than a
 * stack).
 */
function generations(graph) {
    const levels = new Uint32Array(graph.count);
    const corrected = new BigUint64Array(graph.count);
    const done = new Uint8Array(graph.count);
    const stack = [];
    for (let root = 0; root < graph.count; root++) {
        if (done[root])
            continue;
        stack.push(root);
        while (stack.length > 0) {
            const c = stack[stack.length - 1];
            let ready = true;
            for (let p = graph.parentStart[c]; p < graph.parentStart[c + 1]; p++) {
                if (!done[graph.parents[p]]) {
                    ready = false;
                    stack.push(graph.parents[p]);
                }
            }
            if (!ready)
                continue;
            stack.pop();
            if (done[c])
                continue;
            let maxLevel = 0;
            let maxGen = 0n;
            for (let p = graph.parentStart[c]; p < graph.parentStart[c + 1]; p++) {
                maxLevel = Math.max(maxLevel, levels[graph.parents[p]]);
                if (corrected[graph.parents[p]] > maxGen)
                    maxGen = corrected[graph.parents[p]];
            }
            levels[c] = Math.min(maxLevel, GENERATION_NUMBER_V1_MAX - 1) + 1;
            const date = graph.dates[c];
            if (date !== 0n && date > maxGen)
                maxGen = date - 1n;
            corrected[c] = maxGen + 1n;
            done[c] = 1;
        }
    }
    return { levels, corrected };
}
/** The graph file for `graph`'s commits (one layer, no base). */
export function writeCommitGraph(graph) {
    const { count, oids, trees, dates, parentStart, parents } = graph;
    const { levels, corrected } = generations(graph);
    const fanout = new Uint8Array(256 * 4);
    {
        const view = new DataView(fanout.buffer);
        let i = 0;
        for (let byte = 0; byte < 256; byte++) {
            while (i < count && oids[i * OID_BYTES] === byte)
                i++;
            view.setUint32(byte * 4, i);
        }
    }
    const edges = [];
    const data = new Uint8Array(count * (OID_BYTES + 16));
    const dataView = new DataView(data.buffer);
    for (let c = 0; c < count; c++) {
        const at = c * (OID_BYTES + 16);
        data.set(trees.subarray(c * OID_BYTES, (c + 1) * OID_BYTES), at);
        const first = parentStart[c];
        const n = parentStart[c + 1] - first;
        dataView.setUint32(at + OID_BYTES, n >= 1 ? parents[first] : GRAPH_PARENT_NONE);
        let second = GRAPH_PARENT_NONE;
        if (n === 2)
            second = parents[first + 1];
        else if (n > 2) {
            second = (GRAPH_EXTRA_EDGES_NEEDED | edges.length) >>> 0;
            for (let p = 1; p < n; p++)
                edges.push(p === n - 1 ? (parents[first + p] | GRAPH_LAST_EDGE) >>> 0 : parents[first + p]);
        }
        dataView.setUint32(at + OID_BYTES + 4, second);
        const date = dates[c];
        dataView.setUint32(at + OID_BYTES + 8, ((Number((date >> 32n) & 3n)) | (levels[c] << 2)) >>> 0);
        dataView.setUint32(at + OID_BYTES + 12, Number(date & 0xffffffffn));
    }
    const generation = new Uint8Array(count * 4);
    const generationView = new DataView(generation.buffer);
    const overflows = [];
    for (let c = 0; c < count; c++) {
        const offset = (corrected[c] - dates[c]) & UINT64_MAX;
        if (offset > GENERATION_NUMBER_V2_OFFSET_MAX) {
            generationView.setUint32(c * 4, (CORRECTED_COMMIT_DATE_OFFSET_OVERFLOW | overflows.length) >>> 0);
            overflows.push(offset);
        }
        else {
            generationView.setUint32(c * 4, Number(offset));
        }
    }
    const chunks = [['OIDF', fanout], ['OIDL', oids], ['CDAT', data], ['GDA2', generation]];
    if (overflows.length > 0) {
        const overflow = new Uint8Array(overflows.length * 8);
        const view = new DataView(overflow.buffer);
        overflows.forEach((offset, i) => view.setBigUint64(i * 8, offset));
        chunks.push(['GDO2', overflow]);
    }
    if (edges.length > 0) {
        const edge = new Uint8Array(edges.length * 4);
        const view = new DataView(edge.buffer);
        edges.forEach((value, i) => view.setUint32(i * 4, value));
        chunks.push(['EDGE', edge]);
    }
    return chunkFile(chunks);
}
/** git's chunk-format.c: header, table of contents, chunks, SHA-1 trailer. */
function chunkFile(chunks) {
    const tableBytes = (chunks.length + 1) * 12;
    let size = 8 + tableBytes;
    for (const [, bytes] of chunks)
        size += bytes.byteLength;
    const out = new Uint8Array(size + OID_BYTES);
    const view = new DataView(out.buffer);
    out.set([0x43, 0x47, 0x50, 0x48 /* CGPH */, 1, 1, chunks.length, 0]);
    let offset = 8 + tableBytes;
    chunks.forEach(([id, bytes], i) => {
        for (let k = 0; k < 4; k++)
            out[8 + i * 12 + k] = id.charCodeAt(k);
        view.setBigUint64(8 + i * 12 + 4, BigInt(offset));
        out.set(bytes, offset);
        offset += bytes.byteLength;
    });
    view.setBigUint64(8 + chunks.length * 12 + 4, BigInt(offset));
    out.set(createHash('sha1').update(out.subarray(0, size)).digest(), size);
    return out;
}
/** A layer's name: its trailing hash, in hex. */
export function graphName(file) {
    return hex(file.subarray(file.byteLength - OID_BYTES));
}
