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
export function commitRecord(oid: Uint8Array, data: Uint8Array): Uint8Array {
  // parse_commit_buffer: "tree <hex>\n", then "parent <hex>\n" lines.
  const TREE_LINE = 5 + 40;
  if (data.byteLength <= TREE_LINE + 1 || latin1.decode(data.subarray(0, 5)) !== 'tree ' || data[TREE_LINE] !== 0x0a) {
    throw new PackFormatError('bogus commit object ' + hex(oid));
  }
  const tree = hexBytes(data, 5, oid);
  const parents: Uint8Array[] = [];
  const PARENT_LINE = 7 + 40;
  let at = TREE_LINE + 1;
  while (at + PARENT_LINE < data.byteLength && latin1.decode(data.subarray(at, at + 7)) === 'parent ') {
    if (data.byteLength <= at + PARENT_LINE + 1 || data[at + PARENT_LINE] !== 0x0a) throw new PackFormatError('bad parents in commit ' + hex(oid));
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
function parseCommitDate(data: Uint8Array, at: number): bigint {
  const tail = data.byteLength;
  if (at + 6 >= tail || latin1.decode(data.subarray(at, at + 6)) !== 'author') return 0n;
  while (at < tail && data[at++] !== 0x0a);
  if (at + 9 >= tail || latin1.decode(data.subarray(at, at + 9)) !== 'committer') return 0n;
  const eol = data.indexOf(0x0a, at);
  if (eol === -1) return 0n;
  let date = eol;
  while (date > at && data[date - 1] !== 0x3e /* > */) date--;
  if (date === at) return 0n;
  while (date < eol && isSpace(data[date])) date++;
  if (!isDigit(data[date]) && data[date] !== 0x2d /* - */) return 0n;
  return parseTimestamp(data, date);
}

/** strtoumax(…, 10) as git's parse_timestamp is: a sign, digits, saturating at UINTMAX_MAX, a minus wrapping. */
function parseTimestamp(data: Uint8Array, at: number): bigint {
  let negative = false;
  if (data[at] === 0x2d || data[at] === 0x2b) negative = data[at++] === 0x2d;
  let value = 0n;
  let overflow = false;
  for (; at < data.byteLength && isDigit(data[at]); at++) {
    value = value * 10n + BigInt(data[at] - 0x30);
    if (value > UINT64_MAX) overflow = true;
  }
  if (overflow) return UINT64_MAX;
  return negative ? (UINT64_MAX + 1n - value) & UINT64_MAX : value;
}

const isDigit = (c: number | undefined) => c !== undefined && c >= 0x30 && c <= 0x39;
// C's isspace in the C locale.
const isSpace = (c: number | undefined) => c === 0x20 || (c !== undefined && c >= 0x09 && c <= 0x0d);

/** get_oid_hex: 40 hex digits, either case, from `at`. */
function hexBytes(data: Uint8Array, at: number, oid: Uint8Array): Uint8Array {
  const out = new Uint8Array(OID_BYTES);
  for (let i = 0; i < OID_BYTES; i++) {
    const high = hexValue(data[at + 2 * i]);
    const low = hexValue(data[at + 2 * i + 1]);
    if (high < 0 || low < 0) throw new PackFormatError('bad object id in commit ' + hex(oid));
    out[i] = (high << 4) | low;
  }
  return out;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** The records of a staged list (commitRecord's, back to back), as views of its bytes. */
export function* commitRecords(bytes: Uint8Array): Generator<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.byteLength;) {
    if (at + 2 * OID_BYTES + 10 > bytes.byteLength) throw new PackFormatError('a commit record runs past its list');
    const length = 2 * OID_BYTES + 10 + view.getUint16(at + 2 * OID_BYTES + 8) * OID_BYTES;
    if (at + length > bytes.byteLength) throw new PackFormatError('a commit record runs past its list');
    yield bytes.subarray(at, at + length);
    at += length;
  }
}

/**
 * The graph a clone writes from its staged record lists, or null when it
 * writes none: a parent not recorded, or anything else that fails to
 * build. A graph is the clone's to offer, never its to fail on.
 */
export function cloneGraph(lists: readonly Uint8Array[]): { file: Uint8Array; commits: number } | null {
  try {
    const records: Uint8Array[] = [];
    // One at a time: a history's records are too many to spread as arguments.
    for (const list of lists) for (const record of commitRecords(list)) records.push(record);
    return { file: writeCommitGraph(graphCommits(records)), commits: records.length };
  } catch {
    return null;
  }
}

/** The commits of a graph, held as columns, in graph (id) order. */
export interface GraphCommits {
  count: number;
  /** Ids, ascending: OID_BYTES each. */
  oids: Uint8Array;
  trees: Uint8Array;
  dates: BigUint64Array;
  /** Commit i's parents are parents[parentStart[i] .. parentStart[i + 1]), as graph positions. */
  parentStart: Uint32Array;
  parents: Uint32Array;
}

/**
 * The graph's commits from their records (any order, each once): sorted by
 * id, each parent resolved to its position. A parent missing from the
 * records throws: `--reachable` takes every one.
 */
export function graphCommits(records: Iterable<Uint8Array>): GraphCommits {
  const list = [...records];
  const count = list.length;
  const byId = list.map((record, i) => i).sort((a, b) => compareOid(list[a], 0, list[b], 0));
  const oids = new Uint8Array(count * OID_BYTES);
  byId.forEach((from, i) => oids.set(list[from].subarray(0, OID_BYTES), i * OID_BYTES));
  for (let i = 1; i < count; i++) {
    if (compareOid(oids, (i - 1) * OID_BYTES, oids, i * OID_BYTES) === 0) throw new PackFormatError('commit ' + hex(oids.subarray(i * OID_BYTES, (i + 1) * OID_BYTES)) + ' recorded twice');
  }
  const trees = new Uint8Array(count * OID_BYTES);
  const dates = new BigUint64Array(count);
  const parentStart = new Uint32Array(count + 1);
  let parentCount = 0;
  for (const record of list) parentCount += new DataView(record.buffer, record.byteOffset).getUint16(2 * OID_BYTES + 8);
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
      if (position < 0) throw new PackFormatError('missing parent ' + hex(record.subarray(at, at + OID_BYTES)) + ' for commit ' + hex(record.subarray(0, OID_BYTES)));
      parents[next++] = position;
    }
  });
  parentStart[count] = next;
  return { count, oids, trees, dates, parentStart, parents };
}

function compareOid(a: Uint8Array, aAt: number, b: Uint8Array, bAt: number): number {
  for (let i = 0; i < OID_BYTES; i++) {
    const d = a[aAt + i] - b[bAt + i];
    if (d !== 0) return d;
  }
  return 0;
}

function findOid(oids: Uint8Array, count: number, key: Uint8Array, at: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const d = compareOid(oids, mid * OID_BYTES, key, at);
    if (d === 0) return mid;
    if (d < 0) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}

/**
 * Each commit's topological level and corrected commit date, as git's
 * compute_generation_from_max takes them from its parents': a commit after
 * every one of its parents (an iterative walk: a history is deeper than a
 * stack).
 */
function generations(graph: GraphCommits): { levels: Uint32Array; corrected: BigUint64Array } {
  const levels = new Uint32Array(graph.count);
  const corrected = new BigUint64Array(graph.count);
  const done = new Uint8Array(graph.count);
  const stack: number[] = [];
  for (let root = 0; root < graph.count; root++) {
    if (done[root]) continue;
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
      if (!ready) continue;
      stack.pop();
      if (done[c]) continue;
      let maxLevel = 0;
      let maxGen = 0n;
      for (let p = graph.parentStart[c]; p < graph.parentStart[c + 1]; p++) {
        maxLevel = Math.max(maxLevel, levels[graph.parents[p]]);
        if (corrected[graph.parents[p]] > maxGen) maxGen = corrected[graph.parents[p]];
      }
      levels[c] = Math.min(maxLevel, GENERATION_NUMBER_V1_MAX - 1) + 1;
      const date = graph.dates[c];
      if (date !== 0n && date > maxGen) maxGen = date - 1n;
      corrected[c] = maxGen + 1n;
      done[c] = 1;
    }
  }
  return { levels, corrected };
}

/**
 * The graph file for `graph`'s commits (one layer, no base); with
 * `filters` (bloomFilter's, one per commit in graph order), its changed-path
 * chunks too, as `--changed-paths` with commitGraph.changedPathsVersion=2.
 */
export function writeCommitGraph(graph: GraphCommits, filters?: readonly Uint8Array[]): Uint8Array {
  const { count, oids, trees, dates, parentStart, parents } = graph;
  const { levels, corrected } = generations(graph);

  const fanout = new Uint8Array(256 * 4);
  {
    const view = new DataView(fanout.buffer);
    let i = 0;
    for (let byte = 0; byte < 256; byte++) {
      while (i < count && oids[i * OID_BYTES] === byte) i++;
      view.setUint32(byte * 4, i);
    }
  }

  const edges: number[] = [];
  const data = new Uint8Array(count * (OID_BYTES + 16));
  const dataView = new DataView(data.buffer);
  for (let c = 0; c < count; c++) {
    const at = c * (OID_BYTES + 16);
    data.set(trees.subarray(c * OID_BYTES, (c + 1) * OID_BYTES), at);
    const first = parentStart[c];
    const n = parentStart[c + 1] - first;
    dataView.setUint32(at + OID_BYTES, n >= 1 ? parents[first] : GRAPH_PARENT_NONE);
    let second = GRAPH_PARENT_NONE;
    if (n === 2) second = parents[first + 1];
    else if (n > 2) {
      second = (GRAPH_EXTRA_EDGES_NEEDED | edges.length) >>> 0;
      for (let p = 1; p < n; p++) edges.push(p === n - 1 ? (parents[first + p] | GRAPH_LAST_EDGE) >>> 0 : parents[first + p]);
    }
    dataView.setUint32(at + OID_BYTES + 4, second);
    const date = dates[c];
    dataView.setUint32(at + OID_BYTES + 8, ((Number((date >> 32n) & 3n)) | (levels[c] << 2)) >>> 0);
    dataView.setUint32(at + OID_BYTES + 12, Number(date & 0xffffffffn));
  }

  const generation = new Uint8Array(count * 4);
  const generationView = new DataView(generation.buffer);
  const overflows: bigint[] = [];
  for (let c = 0; c < count; c++) {
    const offset = (corrected[c] - dates[c]) & UINT64_MAX;
    if (offset > GENERATION_NUMBER_V2_OFFSET_MAX) {
      generationView.setUint32(c * 4, (CORRECTED_COMMIT_DATE_OFFSET_OVERFLOW | overflows.length) >>> 0);
      overflows.push(offset);
    } else {
      generationView.setUint32(c * 4, Number(offset));
    }
  }

  const chunks: [string, Uint8Array][] = [['OIDF', fanout], ['OIDL', oids], ['CDAT', data], ['GDA2', generation]];
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
  if (filters !== undefined) chunks.push(...filterChunks(filters, count));
  return chunkFile(chunks);
}

// ── Changed-path filters (git's bloom.c, hash version 2) ────────────────────

const BLOOM_HASH_VERSION = 2;
const BLOOM_HASHES = 7;
const BLOOM_BITS_PER_ENTRY = 10;
const BLOOM_HEADER_BYTES = 12;
/** More changed paths than this (directories included) and a commit's filter says "too large". */
export const BLOOM_MAX_CHANGED_PATHS = 512;
const BLOOM_TOO_LARGE = Uint8Array.of(0xff);

/** murmur3_seeded_v2: Murmur3 32-bit over the bytes as unsigned. */
export function murmur3(seed: number, data: Uint8Array): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed >>> 0;
  const blocks = data.byteLength >>> 2;
  for (let i = 0; i < blocks; i++) {
    let k = (data[4 * i] | (data[4 * i + 1] << 8) | (data[4 * i + 2] << 16) | (data[4 * i + 3] << 24)) >>> 0;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  const tail = blocks * 4;
  let k1 = 0;
  switch (data.byteLength & 3) {
    case 3: k1 ^= data[tail + 2] << 16; // falls through
    case 2: k1 ^= data[tail + 1] << 8; // falls through
    case 1:
      k1 ^= data[tail];
      k1 = Math.imul(k1, c1);
      k1 = (k1 << 15) | (k1 >>> 17);
      k1 = Math.imul(k1, c2);
      h ^= k1;
  }
  h ^= data.byteLength;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * A commit's changed-path filter from the paths its first-parent diff
 * changed (null: more than BLOOM_MAX_CHANGED_PATHS changes): each path and
 * its leading directories, 10 bits each, 7 hashes; one zero byte for no
 * paths, one 0xff byte when there are too many.
 */
export function bloomFilter(changed: readonly Uint8Array[] | null): Uint8Array {
  if (changed === null || changed.length > BLOOM_MAX_CHANGED_PATHS) return BLOOM_TOO_LARGE;
  const paths = new Map<string, Uint8Array>();
  for (const path of changed) {
    // The path, then each leading directory, without its '/'.
    for (let end = path.byteLength; end > 0; end = path.lastIndexOf(0x2f /* / */, end - 1)) {
      const prefix = path.subarray(0, end);
      paths.set(latin1.decode(prefix), prefix);
    }
  }
  if (paths.size > BLOOM_MAX_CHANGED_PATHS) return BLOOM_TOO_LARGE;
  const filter = new Uint8Array(Math.max(1, Math.ceil((paths.size * BLOOM_BITS_PER_ENTRY) / 8)));
  const bits = filter.byteLength * 8;
  for (const path of paths.values()) {
    const h0 = murmur3(0x293ae76f, path);
    const h1 = murmur3(0x7e646e2c, path);
    for (let i = 0; i < BLOOM_HASHES; i++) {
      const bit = ((h0 + Math.imul(i, h1)) >>> 0) % bits;
      filter[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return filter;
}

/** One entry of a tree, as the diff walks it. */
interface DiffEntry {
  name: Uint8Array;
  mode: number;
  oid: Uint8Array;
}

/** A tree's entries, by its id. */
export type TreeReader = (oid: Uint8Array) => Promise<Uint8Array>;

const MODE_TREE = 0o040000;
const EMPTY = new Uint8Array(0);

function treeEntries(tree: Uint8Array): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (let p = 0; p < tree.byteLength;) {
    let mode = 0;
    while (p < tree.byteLength && tree[p] !== 0x20) mode = mode * 8 + (tree[p++] - 0x30);
    const nameStart = ++p;
    while (p < tree.byteLength && tree[p] !== 0) p++;
    if (p + 1 + OID_BYTES > tree.byteLength) throw new PackFormatError('tree entry is truncated');
    entries.push({ name: tree.subarray(nameStart, p), mode, oid: tree.subarray(p + 1, p + 1 + OID_BYTES) });
    p += 1 + OID_BYTES;
  }
  return entries;
}

const isTree = (mode: number) => (mode & 0o170000) === MODE_TREE;

/** base_name_compare: names by bytes, a tree's as if it ended in '/'. */
function compareEntries(a: DiffEntry, b: DiffEntry): number {
  const n = Math.min(a.name.byteLength, b.name.byteLength);
  for (let i = 0; i < n; i++) if (a.name[i] !== b.name[i]) return a.name[i] - b.name[i];
  const ca = a.name.byteLength > n ? a.name[n] : isTree(a.mode) ? 0x2f : 0;
  const cb = b.name.byteLength > n ? b.name[n] : isTree(b.mode) ? 0x2f : 0;
  return ca - cb;
}

function joinPath(base: Uint8Array, name: Uint8Array): Uint8Array {
  if (base.byteLength === 0) return name;
  const out = new Uint8Array(base.byteLength + 1 + name.byteLength);
  out.set(base);
  out[base.byteLength] = 0x2f;
  out.set(name, base.byteLength + 1);
  return out;
}

/**
 * The paths a recursive tree diff (git's diff_tree_oid, no renames) of
 * `from` (null: the empty tree) to `to` changes: every file, symlink or
 * submodule added, removed or modified (its id or mode), a directory's by
 * each entry below it. Null once there are more than `limit`.
 */
export async function changedPaths(read: TreeReader, from: Uint8Array | null, to: Uint8Array, limit = BLOOM_MAX_CHANGED_PATHS): Promise<Uint8Array[] | null> {
  const changed: Uint8Array[] = [];
  const add = (path: Uint8Array) => changed.push(path) <= limit;
  // Every leaf below a tree only one side has.
  const all = async (tree: Uint8Array, base: Uint8Array): Promise<boolean> => {
    for (const entry of treeEntries(await read(tree))) {
      const path = joinPath(base, entry.name);
      if (isTree(entry.mode) ? !(await all(entry.oid, path)) : !add(path)) return false;
    }
    return true;
  };
  const walk = async (a: Uint8Array | null, b: Uint8Array | null, base: Uint8Array): Promise<boolean> => {
    const left = a === null ? [] : treeEntries(await read(a));
    const right = b === null ? [] : treeEntries(await read(b));
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      const cmp = i >= left.length ? 1 : j >= right.length ? -1 : compareEntries(left[i], right[j]);
      if (cmp < 0) {
        const entry = left[i++];
        const path = joinPath(base, entry.name);
        if (isTree(entry.mode) ? !(await all(entry.oid, path)) : !add(path)) return false;
      } else if (cmp > 0) {
        const entry = right[j++];
        const path = joinPath(base, entry.name);
        if (isTree(entry.mode) ? !(await all(entry.oid, path)) : !add(path)) return false;
      } else {
        const l = left[i++];
        const r = right[j++];
        if (l.mode === r.mode && equalOid(l.oid, r.oid)) continue;
        const path = joinPath(base, l.name);
        if (isTree(l.mode)) {
          if (!(await walk(l.oid, r.oid, path))) return false;
        } else if (!add(path)) return false;
      }
    }
    return true;
  };
  return (await walk(from, to, EMPTY)) ? changed : null;
}

function equalOid(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < OID_BYTES; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A graph file's chunks, in its own order. */
export function graphChunks(file: Uint8Array): [string, Uint8Array][] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (file.byteLength < 8 + 12 + OID_BYTES || view.getUint32(0) !== 0x43475048 /* CGPH */) throw new PackFormatError('not a commit-graph');
  const count = file[6];
  const chunks: [string, Uint8Array][] = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 12;
    const id = String.fromCharCode(file[at], file[at + 1], file[at + 2], file[at + 3]);
    const start = Number(view.getBigUint64(at + 4));
    const end = Number(view.getBigUint64(at + 16));
    if (start > end || end > file.byteLength - OID_BYTES) throw new PackFormatError('a commit-graph chunk runs past the file');
    chunks.push([id, file.subarray(start, end)]);
  }
  return chunks;
}

/** One layer's commits as the filters pass reads them: each one's root tree, first parent and date. */
export interface LayerCommits {
  count: number;
  tree(position: number): Uint8Array;
  /** Its first parent's position, or -1 for a root. */
  firstParent(position: number): number;
  date(position: number): bigint;
}

/** A base layer's commits (no BASE chunk: every parent is in it). */
export function layerCommits(file: Uint8Array): LayerCommits {
  const chunks = new Map(graphChunks(file));
  const data = chunks.get('CDAT');
  const oids = chunks.get('OIDL');
  if (data === undefined || oids === undefined || chunks.has('BASE')) throw new PackFormatError('not a base commit-graph layer');
  const stride = OID_BYTES + 16;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    count: oids.byteLength / OID_BYTES,
    tree: (c) => data.subarray(c * stride, c * stride + OID_BYTES),
    firstParent: (c) => {
      const parent = view.getUint32(c * stride + OID_BYTES);
      return parent === GRAPH_PARENT_NONE ? -1 : parent;
    },
    date: (c) => (BigInt(view.getUint32(c * stride + OID_BYTES + 8) & 3) << 32n) | BigInt(view.getUint32(c * stride + OID_BYTES + 12)),
  };
}

/** `file`, a graph without changed-path chunks, with `filters` (one per commit, in graph order) added. */
export function withFilters(file: Uint8Array, filters: readonly Uint8Array[]): Uint8Array {
  const chunks = graphChunks(file);
  if (chunks.some(([id]) => id === 'BIDX' || id === 'BDAT' || id === 'BASE')) throw new PackFormatError('the layer is not a base without filters');
  return chunkFile([...chunks, ...filterChunks(filters, chunks.find(([id]) => id === 'OIDL')![1].byteLength / OID_BYTES)]);
}

/** BIDX and BDAT for `filters`, one per commit. */
function filterChunks(filters: readonly Uint8Array[], count: number): [string, Uint8Array][] {
  if (filters.length !== count) throw new PackFormatError(`${filters.length} changed-path filters for ${count} commits`);
  const index = new Uint8Array(count * 4);
  const indexView = new DataView(index.buffer);
  let size = 0;
  filters.forEach((filter, i) => indexView.setUint32(i * 4, (size += filter.byteLength)));
  const bloom = new Uint8Array(BLOOM_HEADER_BYTES + size);
  const bloomView = new DataView(bloom.buffer);
  bloomView.setUint32(0, BLOOM_HASH_VERSION);
  bloomView.setUint32(4, BLOOM_HASHES);
  bloomView.setUint32(8, BLOOM_BITS_PER_ENTRY);
  let at = BLOOM_HEADER_BYTES;
  for (const filter of filters) {
    bloom.set(filter, at);
    at += filter.byteLength;
  }
  return [['BIDX', index], ['BDAT', bloom]];
}

/** git's chunk-format.c: header, table of contents, chunks, SHA-1 trailer. */
function chunkFile(chunks: readonly [string, Uint8Array][]): Uint8Array {
  const tableBytes = (chunks.length + 1) * 12;
  let size = 8 + tableBytes;
  for (const [, bytes] of chunks) size += bytes.byteLength;
  const out = new Uint8Array(size + OID_BYTES);
  const view = new DataView(out.buffer);
  out.set([0x43, 0x47, 0x50, 0x48 /* CGPH */, 1, 1, chunks.length, 0]);
  let offset = 8 + tableBytes;
  chunks.forEach(([id, bytes], i) => {
    for (let k = 0; k < 4; k++) out[8 + i * 12 + k] = id.charCodeAt(k);
    view.setBigUint64(8 + i * 12 + 4, BigInt(offset));
    out.set(bytes, offset);
    offset += bytes.byteLength;
  });
  view.setBigUint64(8 + chunks.length * 12 + 4, BigInt(offset));
  out.set(createHash('sha1').update(out.subarray(0, size)).digest(), size);
  return out;
}

/** A layer's name: its trailing hash, in hex. */
export function graphName(file: Uint8Array): string {
  return hex(file.subarray(file.byteLength - OID_BYTES));
}
