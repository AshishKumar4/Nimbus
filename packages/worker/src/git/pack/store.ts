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
import { OID_BYTES, compareOids, oidFromHex, oidToHex, PackFormatError } from './format.js';
import { IDX_HEADER_BYTES, idxLayout, parseIdxHeader } from './idx.js';
import { MissingBaseError, PackObjectResolver, runAsync, type BaseCache, type CachedObject, type PackRange, type RefBase, type ResolvedObject } from './reader.js';

/** The filesystem calls a store makes. */
export interface PackStoreFs {
  /** Bytes [offset, offset + length) of `path`, clipped to its end. */
  readRange(path: string, offset: number, length: number): Promise<Uint8Array>;
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
/** Pack bytes are read in pages this long, PACK_PAGE_CACHE_BYTES of them kept. */
const PACK_PAGE_BYTES = 1024 * 1024;
const PACK_PAGE_CACHE_BYTES = 8 * 1024 * 1024;

interface Page {
  bytes: Uint8Array;
  byteLength: number;
}

class PackHandle {
  fanout: Uint32Array | null = null;
  resolver: PackObjectResolver | null = null;

  constructor(readonly name: string, readonly idxPath: string, readonly packPath: string) {}

  get count(): number {
    return this.fanout === null ? 0 : this.fanout[255];
  }
}

export class PackObjectStore {
  /** The packs in search order; replaced, never changed in place (promote). */
  private packs: readonly PackHandle[] | null = null;
  private readonly cache: ByteLru<string, CachedObject>;
  private readonly pages: ByteLru<string, Page>;
  private readonly packPages = new ByteLru<string, Page>(PACK_PAGE_CACHE_BYTES);

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
    // The object is the command's, read once: only the bases it is built on are cached.
    const object = await runAsync(found.pack.resolver!.objectAt(found.offset, false), (range) => this.fetch(range));
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

  private async list(): Promise<readonly PackHandle[]> {
    if (this.packs !== null) return this.packs;
    const dir = this.gitdir + '/objects/pack';
    const listed = await this.fs.readdir(dir);
    const present = new Set(listed);
    const packs: PackHandle[] = [];
    for (const idxName of listed.filter((name) => name.startsWith('pack-') && name.endsWith('.idx')).sort()) {
      const name = idxName.slice(0, -4);
      // An idx without its pack is a fetch caught between the two; git skips it too.
      if (!present.has(name + '.pack')) continue;
      const pack = new PackHandle(name, dir + '/' + idxName, dir + '/' + name + '.pack');
      pack.fanout = parseIdxHeader(await runAsync(this.page(pack.idxPath, 0, IDX_HEADER_BYTES), (range) => this.fetch(range)));
      pack.resolver = new PackObjectResolver({
        file: pack.packPath,
        // The pack's length is not asked for (a stat apiece): a read past
        // its end comes back short, and an entry cut short fails to inflate.
        dataEnd: Number.MAX_SAFE_INTEGER,
        cache: new CacheView(this.cache, pack.name),
        refBase: (base) => this.refBase(pack, base),
      });
      packs.push(pack);
    }
    this.packs = packs;
    return packs;
  }

  /**
   * The pack holding `oid`, searched most recently used first, as git's
   * packed_git_mru: neighbouring objects (a history's trees, a checkout's
   * blobs) are mostly in one pack, and a clone has scores of packs. Each
   * search walks the order as it was when it began (the list is never
   * changed in place: concurrent searches each promote by replacing it).
   */
  private async locate(oid: string, retried = false): Promise<{ pack: PackHandle; offset: number } | null> {
    const target = oidFromHex(oid);
    for (const pack of await this.list()) {
      const offset = await runAsync(this.find(pack, target), (range) => this.fetch(range));
      if (offset === null) continue;
      this.promote(pack);
      return { pack, offset };
    }
    // A pack written since the list was taken (git's reprepare_packed_git).
    if (!retried) {
      this.refresh();
      return this.locate(oid, true);
    }
    return null;
  }

  /** `pack` first in the order, the rest as they were; a list refreshed since orders itself. */
  private promote(pack: PackHandle): void {
    const current = this.packs;
    if (current === null || current[0] === pack || !current.includes(pack)) return;
    this.packs = [pack, ...current.filter((other) => other !== pack)];
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
    if (range.file.endsWith('.pack')) return await this.fromPackPages(range);
    // A read may end early where the file does: page() checks what an idx
    // read uses, and an entry cut short fails to inflate.
    return await this.fs.readRange(range.file, range.offset, range.length);
  }

  /**
   * A pack range from cached PACK_PAGE_BYTES pages: objects a command reads
   * together sit together in a pack (a checkout reads in tree order, which
   * git writes in), so a page serves many of them. Where every read is an
   * RPC, a checkout chunk of 10,000 entries costs pack bytes / page reads,
   * not one per object; and no read is longer than a page, so an object of
   * any size crosses an RPC that refuses large reads.
   */
  private async fromPackPages(range: PackRange): Promise<Uint8Array> {
    const first = Math.floor(range.offset / PACK_PAGE_BYTES);
    const last = Math.floor((range.offset + range.length - 1) / PACK_PAGE_BYTES);
    const out = first === last ? null : new Uint8Array(range.length);
    let filled = 0;
    for (let p = first; p <= last; p++) {
      const key = range.file + '@' + p;
      let page = this.packPages.get(key);
      if (page === undefined) {
        const bytes = await this.fs.readRange(range.file, p * PACK_PAGE_BYTES, PACK_PAGE_BYTES);
        page = { bytes, byteLength: bytes.byteLength };
        this.packPages.set(key, page);
      }
      const from = Math.max(range.offset, p * PACK_PAGE_BYTES) - p * PACK_PAGE_BYTES;
      const to = Math.min(range.offset + range.length, (p + 1) * PACK_PAGE_BYTES) - p * PACK_PAGE_BYTES;
      // A range clipped by the pack's end comes back short, as from the file.
      const piece = page.bytes.subarray(from, Math.min(to, page.byteLength));
      if (out === null) return piece;
      out.set(piece, filled);
      filled += piece.byteLength;
      if (piece.byteLength < to - from) return out.subarray(0, filled);
    }
    return out!;
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
   * Fetch, in one request, those of `oids` a partial clone lacks, in its
   * packs and as loose objects (git batches a checkout's, a diff's, a
   * merge's); a no-op where nothing is missing or the repository has no
   * promisor remote.
   */
  prefetch(gitdir: string, oids: Iterable<string>): Promise<void>;
  /** Forget `gitdir`'s pack list: a pack was added. */
  refresh(gitdir: string): void;
}

/**
 * A partial clone's promisor remote: fetches `oids` into a new pack, or
 * declines (false) when `gitdir` has none, as git reads a missing object as
 * absent outside a partial clone.
 */
export type PromisorFetch = (gitdir: string, oids: string[]) => Promise<boolean>;

/**
 * Those of `oids` that are not loose objects of `gitdir`: what a command
 * stages or commits in a partial clone is written loose, and the promisor
 * never had it. One listing of objects/, then one of each fan-out directory
 * an id names, only where it exists.
 */
async function withoutLoose(fs: PackStoreFs, gitdir: string, oids: string[]): Promise<string[]> {
  if (oids.length === 0) return oids;
  const fanout = new Set(await fs.readdir(gitdir + '/objects'));
  const listed = new Map<string, Set<string>>();
  const missing: string[] = [];
  for (const oid of oids) {
    const dir = oid.slice(0, 2);
    let names = listed.get(dir);
    if (names === undefined) {
      names = fanout.has(dir) ? new Set(await fs.readdir(gitdir + '/objects/' + dir)) : new Set();
      listed.set(dir, names);
    }
    if (!names.has(oid.slice(2))) missing.push(oid);
  }
  return missing;
}

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
      const unpacked: string[] = [];
      for (const oid of new Set(oids)) if (!await store(gitdir).has(oid)) unpacked.push(oid);
      await fetchMissing(gitdir, await withoutLoose(fs, gitdir, unpacked));
    },
    refresh: (gitdir) => store(gitdir).refresh(),
  };
}
