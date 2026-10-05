/**
 * git/pack/store.ts — a repository's packed objects, read by range.
 *
 * No pack and no idx is ever read whole: an idx is consulted a page at a
 * time (its fanout, then a binary search over the pages of its id table),
 * and an object costs its entry and its delta chain's entries, the bases
 * held in a byte-bounded cache shared by every pack. A clone of any size can
 * be read with the memory of its largest object and the two caches.
 *
 * cf-git's readObjectPacked, hasObjectPacked and expandOidPacked delegate
 * here when the filesystem it is given carries a store (the tracked patch's
 * seam); Nimbus's filesystems always do.
 */

import { ByteLru } from './byte-lru.js';
import { OID_BYTES, PACK_TRAILER_BYTES, compareOids, oidFromHex, oidToHex, PackFormatError } from './format.js';
import { IDX_HEADER_BYTES, idxLayout, parseIdxHeader } from './idx.js';
import { MissingBaseError, PackObjectResolver, runAsync, type BaseCache, type CachedObject, type PackRange, type RefBase, type ResolvedObject } from './reader.js';

/** The filesystem calls a store makes. */
export interface PackStoreFs {
  /** Bytes [offset, offset + length) of `path`, clipped to its end. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
  size(path: string): Promise<number | null>;
  /** Names in `dir`, or [] when it is absent. */
  readdir(dir: string): Promise<string[]>;
}

export interface PackStoreOptions {
  /** Delta-base cache, bytes, shared by every pack. */
  cacheBytes?: number;
  /** idx page cache, bytes. */
  pageCacheBytes?: number;
}

export interface StoredObject extends ResolvedObject {
  /** The pack it came from, relative to the git directory. */
  source: string;
}

const PAGE_BYTES = 64 * 1024;
const DEFAULT_CACHE_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE_CACHE_BYTES = 4 * 1024 * 1024;

interface Page {
  bytes: Uint8Array;
  byteLength: number;
}

class PackHandle {
  fanout: Uint32Array | null = null;
  packBytes = 0;
  resolver: PackObjectResolver | null = null;

  constructor(readonly name: string, readonly idxPath: string, readonly packPath: string) {}

  get count(): number {
    return this.fanout === null ? 0 : this.fanout[255];
  }
}

export class PackObjectStore {
  private packs: PackHandle[] | null = null;
  private readonly cache: ByteLru<string, CachedObject>;
  private readonly pages: ByteLru<string, Page>;

  constructor(
    private readonly fs: PackStoreFs,
    private readonly gitdir: string,
    options: PackStoreOptions = {},
  ) {
    const cacheBytes = options.cacheBytes ?? DEFAULT_CACHE_BYTES;
    this.cache = new ByteLru(cacheBytes, Math.floor(cacheBytes / 2));
    this.pages = new ByteLru(options.pageCacheBytes ?? DEFAULT_PAGE_CACHE_BYTES);
  }

  /** Whether some pack holds `oid`; no rescan on a miss (a prefetch asks of many it lacks). */
  async has(oid: string): Promise<boolean> {
    return (await this.locate(oid, true)) !== null;
  }

  /** The object, its deltas applied; null when no pack holds it. */
  async read(oid: string): Promise<StoredObject | null> {
    const found = await this.locate(oid);
    if (found === null) return null;
    const object = await runAsync(found.pack.resolver!.objectAt(found.offset), (range) => this.fetch(range));
    return { ...object, source: 'objects/pack/' + found.pack.name + '.pack' };
  }

  /** Every packed id starting with `prefix` (hex). */
  async expand(prefix: string): Promise<string[]> {
    const out: string[] = [];
    if (prefix.length === 0) return out;
    const first = parseInt(prefix.slice(0, 2).padEnd(2, '0'), 16);
    const last = prefix.length >= 2 ? first : first + 15;
    for (const pack of await this.list()) {
      const layout = idxLayout(pack.count);
      for (let i = first === 0 ? 0 : pack.fanout![first - 1]; i < pack.fanout![last]; i++) {
        const hex = oidToHex(await runAsync(this.page(pack.idxPath, layout.ids + i * OID_BYTES, OID_BYTES), (range) => this.fetch(range)), 0);
        if (hex.startsWith(prefix)) out.push(hex);
      }
    }
    return out;
  }

  /** Forget the pack list: a fetch added one. */
  refresh(): void {
    this.packs = null;
  }

  private async list(): Promise<PackHandle[]> {
    if (this.packs !== null) return this.packs;
    const dir = this.gitdir + '/objects/pack';
    const names = (await this.fs.readdir(dir)).filter((name) => name.startsWith('pack-') && name.endsWith('.idx')).sort();
    const packs: PackHandle[] = [];
    for (const idxName of names) {
      const name = idxName.slice(0, -4);
      const pack = new PackHandle(name, dir + '/' + idxName, dir + '/' + name + '.pack');
      const packBytes = await this.fs.size(pack.packPath);
      // An idx without its pack is a fetch caught between the two; git skips it too.
      if (packBytes === null) continue;
      pack.fanout = parseIdxHeader(await runAsync(this.page(pack.idxPath, 0, IDX_HEADER_BYTES), (range) => this.fetch(range)));
      pack.packBytes = packBytes;
      pack.resolver = new PackObjectResolver({
        file: pack.packPath,
        dataEnd: packBytes - PACK_TRAILER_BYTES,
        cache: new CacheView(this.cache, pack.name),
        refBase: (base) => this.refBase(pack, base),
      });
      packs.push(pack);
    }
    this.packs = packs;
    return packs;
  }

  private async locate(oid: string, retried = false): Promise<{ pack: PackHandle; offset: number } | null> {
    const target = oidFromHex(oid);
    for (const pack of await this.list()) {
      const offset = await runAsync(this.find(pack, target), (range) => this.fetch(range));
      if (offset !== null) return { pack, offset };
    }
    // A pack written since the list was taken (git's reprepare_packed_git).
    if (!retried) {
      this.refresh();
      return this.locate(oid, true);
    }
    return null;
  }

  /** Binary search of one idx's fanout bucket, a page at a time; null when absent. */
  private *find(pack: PackHandle, oid: Uint8Array): Generator<PackRange, number | null, Uint8Array> {
    const layout = idxLayout(pack.count);
    let lo = oid[0] === 0 ? 0 : pack.fanout![oid[0] - 1];
    let hi = pack.fanout![oid[0]];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const id: Uint8Array = yield* this.page(pack.idxPath, layout.ids + mid * OID_BYTES, OID_BYTES);
      const order = compareOids(id, 0, oid, 0);
      if (order === 0) {
        const word: Uint8Array = yield* this.page(pack.idxPath, layout.offsets32 + mid * 4, 4);
        const value = ((word[0] << 24) | (word[1] << 16) | (word[2] << 8) | word[3]) >>> 0;
        if ((value & 0x80000000) === 0) return value;
        const wide: Uint8Array = yield* this.page(pack.idxPath, layout.offsets64 + (value & 0x7fffffff) * 8, 8);
        const view = new DataView(wide.buffer, wide.byteOffset, 8);
        return view.getUint32(0) * 0x100000000 + view.getUint32(4);
      }
      if (order < 0) lo = mid + 1;
      else hi = mid;
    }
    return null;
  }

  /** `length` bytes at `at` of `path`, from whole cached pages (a range spans at most two). */
  private *page(path: string, at: number, length: number): Generator<PackRange, Uint8Array, Uint8Array> {
    const first = Math.floor(at / PAGE_BYTES);
    const last = Math.floor((at + length - 1) / PAGE_BYTES);
    const out = first === last ? null : new Uint8Array(length);
    for (let p = first, filled = 0; p <= last; p++) {
      const key = path + '#' + p;
      let page = this.pages.get(key);
      if (page === undefined) {
        const bytes: Uint8Array = yield { file: path, offset: p * PAGE_BYTES, length: PAGE_BYTES };
        page = { bytes, byteLength: bytes.byteLength };
        this.pages.set(key, page);
      }
      const from = Math.max(at, p * PAGE_BYTES) - p * PAGE_BYTES;
      const to = Math.min(at + length, (p + 1) * PAGE_BYTES) - p * PAGE_BYTES;
      if (to > page.byteLength) throw new PackFormatError(path + ' is truncated at ' + (at + length));
      if (out === null) return page.bytes.subarray(from, to);
      out.set(page.bytes.subarray(from, to), filled);
      filled += to - from;
    }
    return out!;
  }

  private async fetch(range: PackRange): Promise<Uint8Array> {
    const bytes = await this.fs.readRange(range.file, range.offset, range.length);
    // An idx page may end early: the file does, and page() checks what it uses.
    if (bytes.byteLength < range.length && !range.file.endsWith('.idx')) {
      throw new PackFormatError(range.file + ': ' + range.length + ' bytes at ' + range.offset + ' came back as ' + bytes.byteLength);
    }
    return bytes;
  }

  /** A ref-delta's base in a stored pack: in the same pack, which on disk is self-contained. */
  private *refBase(pack: PackHandle, oid: Uint8Array): Generator<PackRange, RefBase, Uint8Array> {
    const offset: number | null = yield* this.find(pack, oid);
    if (offset === null) throw new MissingBaseError(oid);
    return { offset };
  }
}

/** One pack's view of the shared base cache: its offsets, keyed under the pack's name. */
class CacheView implements BaseCache {
  constructor(private readonly shared: ByteLru<string, CachedObject>, private readonly pack: string) {}

  get(offset: number): CachedObject | undefined {
    return this.shared.get(this.pack + ':' + offset);
  }

  set(offset: number, object: CachedObject): void {
    this.shared.set(this.pack + ':' + offset, object);
  }
}

/** cf-git's `packs` seam (the tracked patch) over one filesystem: a store per git directory. */
export interface GitPacksSeam {
  read(gitdir: string, oid: string): Promise<StoredObject | null>;
  has(gitdir: string, oid: string): Promise<boolean>;
  expand(gitdir: string, prefix: string): Promise<string[]>;
  /**
   * Fetch, in one request, those of `oids` a partial clone lacks (git batches
   * a checkout's, a diff's, a merge's); a no-op where nothing is missing or
   * the repository has no promisor remote.
   */
  prefetch(gitdir: string, oids: Iterable<string>): Promise<void>;
}

/**
 * A partial clone's promisor remote: fetches `oids` into a new pack, or
 * declines (false) when `gitdir` has none, as git reads a missing object as
 * absent outside a partial clone.
 */
export type PromisorFetch = (gitdir: string, oids: string[]) => Promise<boolean>;

export function packsSeam(fs: PackStoreFs, options: PackStoreOptions & { promisor?: PromisorFetch } = {}): GitPacksSeam {
  const stores = new Map<string, PackObjectStore>();
  const store = (gitdir: string): PackObjectStore => {
    let found = stores.get(gitdir);
    if (found === undefined) stores.set(gitdir, found = new PackObjectStore(fs, gitdir, options));
    return found;
  };
  const fetchMissing = async (gitdir: string, oids: string[]): Promise<boolean> => {
    if (options.promisor === undefined || oids.length === 0) return false;
    if (!await options.promisor(gitdir, oids)) return false;
    store(gitdir).refresh();
    return true;
  };
  return {
    async read(gitdir, oid) {
      const found = await store(gitdir).read(oid);
      if (found !== null) return found;
      // A read the command did not prefetch: git's lazy fetch of one object.
      return await fetchMissing(gitdir, [oid]) ? await store(gitdir).read(oid) : null;
    },
    has: (gitdir, oid) => store(gitdir).has(oid),
    expand: (gitdir, prefix) => store(gitdir).expand(prefix),
    async prefetch(gitdir, oids) {
      const missing: string[] = [];
      for (const oid of new Set(oids)) if (!await store(gitdir).has(oid)) missing.push(oid);
      await fetchMissing(gitdir, missing);
    },
  };
}
