/**
 * git/worktree/dircache.ts — the git index (Documentation/gitformat-index.txt)
 * as its own bytes.
 *
 * A repository's index is held as the file read (every entry in on-disk
 * version 2/3 layout, a version 4 file's prefix-compressed names expanded)
 * and a table of where each entry starts: about 110 bytes a file, no object
 * per entry. A path is decoded only when asked for, and a lookup compares
 * bytes. A stat refresh patches the entry where it lies; any other change is
 * written by one ordered merge of the old entries' bytes with the new ones,
 * which are themselves held as bytes (NewEntries), straight into the file.
 */

import { createHash } from 'node:crypto';

import { oidFromHex, oidToHex } from '../pack/format.js';
import { CacheTree } from './cachetree.js';

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;
export const S_IFGITLINK = 0o160000;

/** The empty blob's id: a size-0 entry naming it is not racily smudged (read-cache.c). */
export const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

const HEADER_BYTES = 12;
const OID_BYTES = 20;
/** ctime, mtime, dev, ino, mode, uid, gid, size, then the object id. */
const FLAGS_AT = 40 + OID_BYTES;
const FIXED_BYTES = FLAGS_AT + 2;
const NAME_MASK = 0x0fff;
const STAGE_MASK = 0x3000;
const EXTENDED = 0x4000;
const VALID = 0x8000;
/** The second flags word (version 3 and up). */
const SKIP_WORKTREE = 0x4000;
const INTENT_TO_ADD = 0x2000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The stat an entry records: the session's lstat, times in ms. */
export interface EntryStat {
  ctimeMs: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  size: number;
}

/** An entry to write: stat null records none (all zero), as read-tree does. */
export interface NewEntry {
  path: string;
  mode: number;
  oid: string;
  stat: EntryStat | null;
  stage?: number;
  skipWorktree?: boolean;
}

/** What one command changes in the index, written in one merge. */
export interface IndexEdit {
  /** Old entries that go, by number. */
  removed?: ReadonlySet<number>;
  /** New entries, in any order; one replaces every old entry at its path. */
  added?: NewEntries;
}

/** The filesystem calls reading and writing the index make (ProjectFs's). */
export interface IndexFs {
  /** The file's bytes, a buffer of the caller's own, past the content cache. */
  readFileUncached(path: string): Promise<Uint8Array> | Uint8Array;
  writeFile(path: string, content: Uint8Array): Promise<void> | void;
  lstat(path: string): Promise<{ mtime: number }> | { mtime: number };
}

/** An index extension: its 4-byte signature and its data (gitformat-index.txt, "Extensions"). */
export interface IndexExtension {
  signature: string;
  bytes: Uint8Array;
}

/** git's name order: the bytes of the path. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** A path's bytes as a string: ASCII without the decoder's cost. */
export function decodePath(bytes: Uint8Array): string {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0x80) return decoder.decode(bytes);
  }
  return String.fromCharCode.apply(null, bytes as unknown as number[]);
}

/** git's order of two paths as strings: their UTF-8 bytes, which is code point order rather than UTF-16's. */
export function comparePaths(a: string, b: string): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // Surrogates (astral code points) sort above the rest of the BMP.
    if (x >= 0xd800) x = x >= 0xe000 ? x - 0x800 : x + 0x2000;
    if (y >= 0xd800) y = y >= 0xe000 ? y - 0x800 : y + 0x2000;
    return x - y;
  }
  return a.length - b.length;
}

/** An entry's length in version 2/3 layout: the name and 1-8 NULs to a multiple of 8. */
function paddedLength(extended: boolean, nameLength: number): number {
  return (FIXED_BYTES + (extended ? 2 : 0) + nameLength + 8) & ~7;
}

/** decode_varint (varint.c), for version 4's strip counts. */
function decodeVarint(bytes: Uint8Array, at: number): [value: number, next: number] {
  let c = bytes[at++];
  let value = c & 127;
  while (c & 128) {
    value += 1;
    c = bytes[at++];
    value = value * 128 + (c & 127);
  }
  return [value, at];
}

function encodeVarint(value: number): number[] {
  const out = [value & 127];
  for (let rest = Math.floor(value / 128); rest; rest = Math.floor(rest / 128)) {
    rest--;
    out.unshift(128 | (rest & 127));
  }
  return out;
}

/** An object's id: SHA-1 of `<type> <size>\0` and the bytes. */
export function objectId(type: string, data: Uint8Array): string {
  return oidToHex(createHash('sha1').update(encoder.encode(`${type} ${data.length}\0`)).update(data).digest());
}

export class IndexFormatError extends Error {}

/** What NewEntries allocates at a time; an entry larger than this gets a chunk of its own. */
const CHUNK_BYTES = 64 * 1024;

/** An entry's flags word, at `at` in `bytes`. */
function flagsAt(bytes: Uint8Array, at: number): number {
  return (bytes[at + FLAGS_AT] << 8) | bytes[at + FLAGS_AT + 1];
}

/** Where an entry's name starts and how long it is, for the entry at `at` in `bytes` (version 2/3 layout). */
function nameAt(bytes: Uint8Array, at: number): [start: number, length: number] {
  const flags = flagsAt(bytes, at);
  const start = at + FIXED_BYTES + (flags & EXTENDED ? 2 : 0);
  const length = flags & NAME_MASK;
  return [start, length < NAME_MASK ? length : bytes.indexOf(0, start) - start];
}

/** The names of two entries in place, in git's order: compareBytes without the views. */
function compareNamesAt(a: Uint8Array, aAt: number, b: Uint8Array, bAt: number): number {
  const [aStart, aLength] = nameAt(a, aAt);
  const [bStart, bLength] = nameAt(b, bAt);
  const n = Math.min(aLength, bLength);
  for (let i = 0; i < n; i++) {
    const d = a[aStart + i] - b[bStart + i];
    if (d !== 0) return d;
  }
  return aLength - bLength;
}

/**
 * New index entries as their bytes, each encoded (encodeIndexEntry's layout)
 * as it is added, into chunks of CHUNK_BYTES: an entry costs its own size and
 * eight bytes, no object. As objects (a path and an id as strings, a stat, a
 * key for the sort, then the encoded piece), staging every file of a large
 * worktree held about 900 bytes a file: 80 MiB for add -A at Linux's 96,000.
 */
export class NewEntries {
  private readonly chunks: Uint8Array[] = [];
  /** Bytes used of the last chunk. */
  private used = 0;
  private chunkOf = new Uint32Array(16);
  private offsetOf = new Uint32Array(16);
  count = 0;

  /** Encode `entry`; its path and stat are not kept. */
  add(entry: NewEntry): void {
    const name = encoder.encode(entry.path);
    const skipWorktree = entry.skipWorktree === true;
    const length = paddedLength(skipWorktree, name.length);
    const last = this.chunks[this.chunks.length - 1];
    if (last === undefined || this.used + length > last.length) {
      this.chunks.push(new Uint8Array(Math.max(CHUNK_BYTES, length)));
      this.used = 0;
    }
    if (this.count === this.chunkOf.length) {
      const chunkOf = new Uint32Array(this.count * 2);
      chunkOf.set(this.chunkOf);
      this.chunkOf = chunkOf;
      const offsetOf = new Uint32Array(this.count * 2);
      offsetOf.set(this.offsetOf);
      this.offsetOf = offsetOf;
    }
    const chunk = this.chunks.length - 1;
    writeIndexEntry(this.chunks[chunk], this.used, name, entry.mode, entry.oid, entry.stat, { stage: entry.stage ?? 0, skipWorktree });
    this.chunkOf[this.count] = chunk;
    this.offsetOf[this.count] = this.used;
    this.count++;
    this.used += length;
  }

  /** Entry `k`'s bytes, a view. */
  entry(k: number): Uint8Array {
    const chunk = this.chunks[this.chunkOf[k]];
    const at = this.offsetOf[k];
    const [start, length] = nameAt(chunk, at);
    return chunk.subarray(at, at + paddedLength(start - at > FIXED_BYTES, length));
  }

  /** Entry `k`'s name bytes, a view. */
  name(k: number): Uint8Array {
    const chunk = this.chunks[this.chunkOf[k]];
    const [start, length] = nameAt(chunk, this.offsetOf[k]);
    return chunk.subarray(start, start + length);
  }

  path(k: number): string {
    return decodePath(this.name(k));
  }

  stage(k: number): number {
    return (flagsAt(this.chunks[this.chunkOf[k]], this.offsetOf[k]) & STAGE_MASK) >> 12;
  }

  /** The order of entries `k` and `j`: by name, then stage. */
  private compare(k: number, j: number): number {
    return compareNamesAt(this.chunks[this.chunkOf[k]], this.offsetOf[k], this.chunks[this.chunkOf[j]], this.offsetOf[j])
      || this.stage(k) - this.stage(j);
  }

  /**
   * The entries' numbers in index order (name, then stage): as added when they
   * came in it, as most commands add them. One path twice at one stage is refused.
   */
  order(): Int32Array {
    const order = new Int32Array(this.count);
    let sorted = true;
    for (let k = 0; k < this.count; k++) {
      order[k] = k;
      if (k > 0 && sorted && this.compare(k - 1, k) > 0) sorted = false;
    }
    if (!sorted) order.sort((k, j) => this.compare(k, j));
    for (let k = 1; k < order.length; k++) {
      if (this.compare(order[k - 1], order[k]) === 0) throw new IndexFormatError(`index: ${this.path(order[k])} added twice`);
    }
    return order;
  }
}

/** No new entries. */
const NO_ENTRIES = new NewEntries();

/** Version 4's name compression, entry by entry: what each entry takes, then its bytes. */
class Version4Names {
  private previous: Uint8Array = new Uint8Array(0);

  /** `entry` (version 2/3 layout) as version 4 writes it: its size, and its bytes when `out` is given. */
  put(entry: Uint8Array, out?: Uint8Array, at = 0): number {
    const flags = flagsAt(entry, 0);
    const fixed = FIXED_BYTES + (flags & EXTENDED ? 2 : 0);
    const [start, length] = nameAt(entry, 0);
    const name = entry.subarray(start, start + length);
    let common = 0;
    while (common < this.previous.length && common < name.length && this.previous[common] === name[common]) common++;
    const strip = encodeVarint(this.previous.length - common);
    this.previous = name;
    const size = fixed + strip.length + name.length - common + 1;
    if (out) {
      out.set(entry.subarray(0, fixed), at);
      out.set(strip, at + fixed);
      out.set(name.subarray(common), at + fixed + strip.length);
      out[at + size - 1] = 0;
    }
    return size;
  }
}

/**
 * The index of one repository. `timestamp` is the index file's mtime in
 * seconds as read (git's istate->timestamp), 0 when there was none: an entry
 * whose mtime is not older is racily clean.
 */
export class DirCache {
  /** Entries verified against the worktree by this command: never smudged (CE_UPTODATE). */
  private readonly uptodate: Uint8Array;
  /** A stat refresh happened: the index is worth writing. */
  refreshed = false;
  /** The checksum the file read ended with (null: there was none): what a revision check compares. */
  readonly trailer: Uint8Array | null;
  /** The TREE extension's bytes as read, or as set; null for none. */
  private treeBytes: Uint8Array | null;
  /** Those bytes read (undefined until asked for); null when there are none git would read. */
  private tree: CacheTree | null | undefined;
  /** The cache tree changed: written, it saves the next command reading trees. */
  cacheTreeChanged = false;

  /** `bytes` are this index's own: a refresh patches them. */
  private constructor(
    private readonly bytes: Uint8Array,
    private readonly offsets: Uint32Array,
    readonly version: number,
    readonly timestamp: number,
    private readonly extensions: IndexExtension[],
    trailer: Uint8Array | null,
  ) {
    this.uptodate = new Uint8Array(offsets.length);
    this.trailer = trailer;
    this.treeBytes = extensions.find(({ signature }) => signature === 'TREE')?.bytes ?? null;
  }

  get count(): number {
    return this.offsets.length;
  }

  /** A repository's index before anything is added: no file yet. */
  static empty(): DirCache {
    return new DirCache(new Uint8Array(0), new Uint32Array(0), 2, 0, [], null);
  }

  /** The index at `file`, empty when there is none. */
  static async read(fs: IndexFs, file: string): Promise<DirCache> {
    let bytes: Uint8Array;
    let mtime: number;
    try {
      mtime = (await fs.lstat(file)).mtime;
      bytes = await fs.readFileUncached(file);
    } catch {
      return DirCache.empty();
    }
    return DirCache.parse(bytes, Math.floor(mtime / 1000));
  }

  /** read_index_from on bytes already read. */
  static parse(bytes: Uint8Array, timestamp: number): DirCache {
    if (bytes.length < HEADER_BYTES + OID_BYTES || decodePath(bytes.subarray(0, 4)) !== 'DIRC') {
      throw new IndexFormatError('index file corrupt');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(4);
    if (version < 2 || version > 4) throw new IndexFormatError(`bad index version ${version}`);
    const count = view.getUint32(8);
    const end = bytes.length - OID_BYTES;
    const digest = createHash('sha1').update(bytes.subarray(0, end)).digest();
    if (compareBytes(new Uint8Array(digest.buffer, digest.byteOffset, OID_BYTES), bytes.subarray(end)) !== 0) {
      throw new IndexFormatError('index file corrupt: bad signature');
    }
    let at = HEADER_BYTES;
    let entries: Uint8Array = bytes;
    const offsets = new Uint32Array(count);
    if (version === 4) {
      // Expanded to version 3 layout once, so every later read is the same.
      const expanded: Uint8Array[] = [];
      let size = 0;
      let previous: Uint8Array = new Uint8Array(0);
      for (let i = 0; i < count; i++) {
        const flags = view.getUint16(at + FLAGS_AT);
        const extended = (flags & EXTENDED) !== 0;
        const fixed = FIXED_BYTES + (extended ? 2 : 0);
        const [strip, suffixAt] = decodeVarint(bytes, at + fixed);
        if (strip > previous.length) throw new IndexFormatError('malformed name field in the index');
        const nul = bytes.indexOf(0, suffixAt);
        const name = new Uint8Array(previous.length - strip + nul - suffixAt);
        name.set(previous.subarray(0, previous.length - strip));
        name.set(bytes.subarray(suffixAt, nul), previous.length - strip);
        const entry = new Uint8Array(paddedLength(extended, name.length));
        entry.set(bytes.subarray(at, at + fixed));
        entry.set(name, fixed);
        offsets[i] = HEADER_BYTES + size;
        size += entry.length;
        expanded.push(entry);
        previous = name;
        at = nul + 1;
      }
      entries = new Uint8Array(HEADER_BYTES + size);
      entries.set(bytes.subarray(0, HEADER_BYTES));
      let offset = HEADER_BYTES;
      for (const entry of expanded) {
        entries.set(entry, offset);
        offset += entry.length;
      }
    } else {
      for (let i = 0; i < count; i++) {
        if (at + FIXED_BYTES > end) throw new IndexFormatError('index file corrupt: truncated entry');
        offsets[i] = at;
        const flags = view.getUint16(at + FLAGS_AT);
        const extended = (flags & EXTENDED) !== 0;
        const nameAt = at + FIXED_BYTES + (extended ? 2 : 0);
        let length = flags & NAME_MASK;
        if (length === NAME_MASK) length = bytes.indexOf(0, nameAt) - nameAt;
        at += paddedLength(extended, length);
      }
    }
    const extensions: IndexExtension[] = [];
    while (at + 8 <= end) {
      const signature = decodePath(bytes.subarray(at, at + 4));
      const size = view.getUint32(at + 4);
      const data = bytes.subarray(at + 8, at + 8 + size);
      at += 8 + size;
      if (signature === 'link') throw new IndexFormatError('the index is split (core.splitIndex), which this git does not read');
      if (signature === 'sdir') throw new IndexFormatError('the index is sparse (index.sparse), which this git does not read');
      if (signature[0] < 'A' || signature[0] > 'Z') {
        throw new IndexFormatError(`index uses ${signature} extension, which we do not understand`);
      }
      extensions.push({ signature, bytes: data });
    }
    return new DirCache(entries, offsets, version, timestamp, extensions, bytes.slice(end));
  }

  private u32(i: number, field: number): number {
    const at = this.offsets[i] + field;
    const b = this.bytes;
    return ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
  }

  private flags(i: number): number {
    const at = this.offsets[i] + FLAGS_AT;
    return (this.bytes[at] << 8) | this.bytes[at + 1];
  }

  private extendedFlags(i: number): number {
    if (!(this.flags(i) & EXTENDED)) return 0;
    const at = this.offsets[i] + FIXED_BYTES;
    return (this.bytes[at] << 8) | this.bytes[at + 1];
  }

  /** Entry `i`'s name bytes, a view of the index. */
  pathBytes(i: number): Uint8Array {
    const at = this.offsets[i];
    const flags = this.flags(i);
    const nameAt = at + FIXED_BYTES + (flags & EXTENDED ? 2 : 0);
    let length = flags & NAME_MASK;
    if (length === NAME_MASK) length = this.bytes.indexOf(0, nameAt) - nameAt;
    return this.bytes.subarray(nameAt, nameAt + length);
  }

  path(i: number): string {
    return decodePath(this.pathBytes(i));
  }

  mode(i: number): number {
    return this.u32(i, 24);
  }

  oidBytes(i: number): Uint8Array {
    const at = this.offsets[i] + 40;
    return this.bytes.subarray(at, at + OID_BYTES);
  }

  oid(i: number): string {
    return oidToHex(this.bytes, this.offsets[i] + 40);
  }

  stage(i: number): number {
    return (this.flags(i) & STAGE_MASK) >> 12;
  }

  /** CE_VALID: assume unchanged, never stat'd. */
  assumeValid(i: number): boolean {
    return (this.flags(i) & VALID) !== 0;
  }

  skipWorktree(i: number): boolean {
    return (this.extendedFlags(i) & SKIP_WORKTREE) !== 0;
  }

  intentToAdd(i: number): boolean {
    return (this.extendedFlags(i) & INTENT_TO_ADD) !== 0;
  }

  ctimeSeconds(i: number): number { return this.u32(i, 0); }
  mtimeSeconds(i: number): number { return this.u32(i, 8); }
  ino(i: number): number { return this.u32(i, 20); }
  uid(i: number): number { return this.u32(i, 28); }
  gid(i: number): number { return this.u32(i, 32); }
  size(i: number): number { return this.u32(i, 36); }

  /** The first entry at or after `key` (path bytes) in [lo, hi). */
  lowerBound(key: Uint8Array, lo = 0, hi = this.count): number {
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareBytes(this.pathBytes(mid), key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The paths with unmerged entries (stages 1-3), each once, in index order. */
  unmergedPaths(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.count; i++) {
      if (this.stage(i) === 0) continue;
      const path = this.path(i);
      if (out[out.length - 1] !== path) out.push(path);
    }
    return out;
  }

  /** The first entry at `path` (its lowest stage), or -1. */
  find(path: string): number {
    const key = encoder.encode(path);
    const at = this.lowerBound(key);
    return at < this.count && compareBytes(this.pathBytes(at), key) === 0 ? at : -1;
  }

  /** [lo, hi): the entries below directory `dir` ('' is the whole index). */
  rangeUnder(dir: string, lo = 0, hi = this.count): [number, number] {
    if (!dir) return [lo, hi];
    const key = encoder.encode(`${dir}/`);
    const first = this.lowerBound(key, lo, hi);
    // '0' follows '/': the first name past the directory's.
    key[key.length - 1] = 0x30;
    return [first, this.lowerBound(key, first, hi)];
  }

  /** The index's cache tree (its TREE extension), or null when it has none git would read. */
  cacheTree(): CacheTree | null {
    if (this.tree === undefined) this.tree = this.treeBytes === null ? null : CacheTree.parse(this.treeBytes);
    return this.tree;
  }

  /** Record `bytes` as the index's TREE extension, when they say something the one held does not. */
  setCacheTree(bytes: Uint8Array): void {
    if (this.treeBytes !== null && compareBytes(this.treeBytes, bytes) === 0) return;
    this.treeBytes = bytes;
    this.tree = undefined;
    this.cacheTreeChanged = true;
  }

  /** Mark entry `i` checked against the worktree by this command. */
  markUptodate(i: number): void {
    this.uptodate[i] = 1;
  }

  isUptodate(i: number): boolean {
    return this.uptodate[i] === 1;
  }

  /** is_racy_timestamp: entry `i`'s matching stat proves nothing, as it is not older than the index. */
  isRacy(i: number): boolean {
    return this.timestamp !== 0 && (this.mode(i) & S_IFMT) !== S_IFGITLINK && this.mtimeSeconds(i) >= this.timestamp;
  }

  /** fill_stat_cache_info: entry `i` takes the file's fresh stat, its content having matched. */
  refresh(i: number, stat: EntryStat): void {
    writeStat(this.bytes, this.offsets[i], stat);
    this.uptodate[i] = 1;
    this.refreshed = true;
  }

  /** Where entry `i` ends: the next one's start, or its own padded length for the last. */
  private entryEnd(i: number): number {
    const start = this.offsets[i];
    return i + 1 < this.count ? this.offsets[i + 1] : start + paddedLength((this.flags(i) & EXTENDED) !== 0, this.pathBytes(i).length);
  }

  /**
   * The ordered merge an edit writes: the old entries but `removed` and those
   * an added one replaces, and the added ones (`order`), each passed to
   * `emit` in path order. Old entries kept one after another go as one run
   * (but at version 4, which re-encodes each name); a `smudged` one alone.
   */
  private merge(
    added: NewEntries, order: Int32Array, removed: ReadonlySet<number>, smudged: ReadonlySet<number>,
    emit: (piece: Uint8Array, smudge: boolean) => void,
  ): { count: number; extended: boolean } {
    const runs = this.version !== 4;
    let count = 0;
    let extended = false;
    let runStart = -1;
    let runEnd = -1;
    const flush = () => {
      if (runStart < 0) return;
      emit(this.bytes.subarray(runStart, runEnd), false);
      runStart = -1;
    };
    let a = 0;
    for (let i = 0; i <= this.count; i++) {
      const key = i < this.count ? this.pathBytes(i) : null;
      // New entries before this one; one at its path replaces it.
      while (a < order.length && (key === null || compareBytes(added.name(order[a]), key) <= 0)) {
        flush();
        const piece = added.entry(order[a++]);
        extended ||= (flagsAt(piece, 0) & EXTENDED) !== 0;
        emit(piece, false);
        count++;
      }
      if (key === null) break;
      if (removed.has(i)) continue;
      if (a > 0 && compareBytes(added.name(order[a - 1]), key) === 0) continue;
      // An entry is copied in its own layout: one with the second flags word keeps the file at version 3.
      extended ||= (this.flags(i) & EXTENDED) !== 0;
      count++;
      const start = this.offsets[i];
      const end = this.entryEnd(i);
      if (!runs || smudged.has(i)) {
        flush();
        emit(this.bytes.subarray(start, end), smudged.has(i));
      } else if (runStart >= 0 && runEnd === start) {
        runEnd = end;
      } else {
        flush();
        runStart = start;
        runEnd = end;
      }
    }
    flush();
    return { count, extended };
  }

  /**
   * The index file with `edit` applied: header, entries in path order, the
   * extensions that still hold, and the checksum. `smudged` entries get size
   * 0 (ce_smudge_racily_clean_entry). The cache tree goes once an entry
   * changes, and the untracked cache and monitor tokens always: nothing here
   * keeps them, and git rebuilds them.
   *
   * Written straight into the file's bytes: the merge runs once to size the
   * file and once to fill it, so the file is the one copy this makes.
   */
  encode(edit: IndexEdit = {}, smudged: ReadonlySet<number> = new Set()): Uint8Array {
    const removed = edit.removed ?? new Set<number>();
    const added = edit.added ?? NO_ENTRIES;
    // Nothing but stat refreshes, which patched these bytes where they lie: the file is these bytes
    // with a new checksum, and no second copy of the index is made (a status refresh at 96,000 entries).
    if (removed.size === 0 && added.count === 0 && smudged.size === 0 && !this.cacheTreeChanged
      && this.version !== 4 && this.trailer !== null && this.extensions.every(({ signature }) => signature === 'TREE' || signature === 'REUC')) {
      const end = this.bytes.length - OID_BYTES;
      this.bytes.set(createHash('sha1').update(this.bytes.subarray(0, end)).digest(), end);
      return this.bytes;
    }
    const order = added.order();
    const names = this.version === 4 ? new Version4Names() : null;
    // Each pass is given its own name state: version 4 strips against the entry before.
    let body = 0;
    const { count, extended } = this.merge(added, order, removed, smudged, (piece) => {
      body += names ? names.put(piece) : piece.length;
    });
    // The cache tree loses the directories a changed entry is in (cache_tree_invalidate_path); the rest holds.
    const tree = this.cacheTree();
    const changedPaths = function* (dc: DirCache): Generator<string> {
      for (const i of removed) yield dc.path(i);
      for (let k = 0; k < added.count; k++) yield added.path(k);
    };
    const extensions = [
      ...(tree === null ? [] : [{ signature: 'TREE', bytes: tree.invalidate(changedPaths(this)) }]),
      ...this.extensions.filter(({ signature }) => signature === 'REUC'),
    ];
    // Version 3 demotes to 2 when no entry needs the second flags word (do_write_index).
    const version = this.version === 4 ? 4 : extended ? 3 : 2;
    return writeIndexFile(version, count, body, (out, start) => {
      const v4 = this.version === 4 ? new Version4Names() : null;
      let at = start;
      this.merge(added, order, removed, smudged, (piece, smudge) => {
        const entryAt = at;
        if (v4) {
          at += v4.put(piece, out, at);
        } else {
          out.set(piece, at);
          at += piece.length;
        }
        // The size field: the first 40 bytes are laid out alike in every version.
        if (smudge) out.fill(0, entryAt + 36, entryAt + 40);
      });
    }, extensions);
  }
}

/** The file: header, `bodyBytes` of entries (`writeBody` fills them in at `at`), the extensions, the checksum. */
function writeIndexFile(
  version: number, count: number, bodyBytes: number, writeBody: (out: Uint8Array, at: number) => void,
  extensions: readonly IndexExtension[],
): Uint8Array {
  let size = HEADER_BYTES + bodyBytes + OID_BYTES;
  for (const ext of extensions) size += 8 + ext.bytes.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(encoder.encode('DIRC'));
  view.setUint32(4, version);
  view.setUint32(8, count);
  writeBody(out, HEADER_BYTES);
  let at = HEADER_BYTES + bodyBytes;
  for (const ext of extensions) {
    out.set(encoder.encode(ext.signature), at);
    view.setUint32(at + 4, ext.bytes.length);
    out.set(ext.bytes, at + 8);
    at += 8 + ext.bytes.length;
  }
  out.set(createHash('sha1').update(out.subarray(0, at)).digest(), at);
  return out;
}

/** An entry's name bytes, in version 2/3 layout. */
function entryName(entry: Uint8Array): Uint8Array {
  const flags = (entry[FLAGS_AT] << 8) | entry[FLAGS_AT + 1];
  const nameAt = FIXED_BYTES + (flags & EXTENDED ? 2 : 0);
  const length = flags & NAME_MASK;
  return entry.subarray(nameAt, length < NAME_MASK ? nameAt + length : entry.indexOf(0, nameAt));
}

/** Entries in version 2/3 layout laid back to back (a clone batch's share of the index), one by one. */
export function splitIndexEntries(bytes: Uint8Array): Uint8Array[] {
  const entries: Uint8Array[] = [];
  for (let at = 0; at < bytes.length;) {
    const entry = bytes.subarray(at);
    const extended = (entry[FLAGS_AT] & (EXTENDED >> 8)) !== 0;
    const length = paddedLength(extended, entryName(entry).length);
    entries.push(bytes.subarray(at, at + length));
    at += length;
  }
  return entries;
}

/**
 * An index file of `entries` (encodeIndexEntry's, in any order; one path
 * twice at one stage is refused), then `extensions`: version 2, or 3 when an
 * entry has the second flags word. How a clone writes the index it checked
 * out; DirCache.encode writes every later one.
 */
export function encodeIndexFile(entries: readonly Uint8Array[], extensions: readonly IndexExtension[] = []): Uint8Array {
  const stageOf = (entry: Uint8Array) => (entry[FLAGS_AT] >> 4) & 3;
  const keyed = entries.map((entry) => ({ entry, name: entryName(entry), stage: stageOf(entry) }));
  keyed.sort((a, b) => compareBytes(a.name, b.name) || a.stage - b.stage);
  let extended = false;
  for (let i = 0; i < keyed.length; i++) {
    if (i > 0 && compareBytes(keyed[i - 1].name, keyed[i].name) === 0 && keyed[i - 1].stage === keyed[i].stage) {
      throw new IndexFormatError(`index: ${decodePath(keyed[i].name)} appears twice`);
    }
    extended ||= (keyed[i].entry[FLAGS_AT] & (EXTENDED >> 8)) !== 0;
  }
  let body = 0;
  for (const { entry } of keyed) body += entry.length;
  return writeIndexFile(extended ? 3 : 2, keyed.length, body, (out, start) => {
    let at = start;
    for (const { entry } of keyed) {
      out.set(entry, at);
      at += entry.length;
    }
  }, extensions);
}

function writeStat(bytes: Uint8Array, at: number, stat: EntryStat): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, 40);
  const u32 = (field: number, value: number) => view.setUint32(field, Math.floor(value) % 0x100000000);
  u32(0, stat.ctimeMs / 1000);
  u32(4, (Math.floor(stat.ctimeMs) % 1000) * 1e6);
  u32(8, stat.mtimeMs / 1000);
  u32(12, (Math.floor(stat.mtimeMs) % 1000) * 1e6);
  u32(16, stat.dev);
  u32(20, stat.ino);
  u32(28, stat.uid);
  u32(32, stat.gid);
  u32(36, stat.size);
}

/**
 * One entry in version 2/3 layout: its stat (all zero when null, as for an
 * entry never checked out or a gitlink), mode, id, flags, then its name and
 * 1-8 NULs to a multiple of 8. A skip-worktree entry takes the second flags
 * word, which makes the file version 3.
 */
export function encodeIndexEntry(
  path: string | Uint8Array, mode: number, oid: string | Uint8Array, stat: EntryStat | null,
  options: { stage?: number; skipWorktree?: boolean } = {},
): Uint8Array {
  const name = typeof path === 'string' ? encoder.encode(path) : path;
  const out = new Uint8Array(paddedLength(options.skipWorktree === true, name.length));
  writeIndexEntry(out, 0, name, mode, oid, stat, options);
  return out;
}

/** encodeIndexEntry's bytes, written at `at` in `out` (which has room, zeroed). */
function writeIndexEntry(
  out: Uint8Array, at: number, name: Uint8Array, mode: number, oid: string | Uint8Array, stat: EntryStat | null,
  { stage = 0, skipWorktree = false }: { stage?: number; skipWorktree?: boolean } = {},
): void {
  if (stat) writeStat(out, at, stat);
  const view = new DataView(out.buffer, out.byteOffset + at, paddedLength(skipWorktree, name.length));
  view.setUint32(24, mode);
  out.set(typeof oid === 'string' ? oidFromHex(oid) : oid.subarray(0, OID_BYTES), at + 40);
  view.setUint16(FLAGS_AT, (skipWorktree ? EXTENDED : 0) | (stage << 12) | Math.min(name.length, NAME_MASK));
  if (skipWorktree) view.setUint16(FIXED_BYTES, SKIP_WORKTREE);
  out.set(name, at + FIXED_BYTES + (skipWorktree ? 2 : 0));
}

