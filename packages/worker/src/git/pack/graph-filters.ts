/**
 * git/pack/graph-filters.ts — a full clone's commit-graph (commit-graph.ts),
 * written after the clone has answered, so nothing of it is on the way to
 * the prompt: its base layer first, then its changed-path filters, computed
 * in pieces and added to it, as `git commit-graph write --changed-paths`
 * would have written them.
 *
 *   plan      what a pass that did not finish left (its temporary layers and
 *             pieces) goes; then the base layer from the commit records the
 *             clone's history left (GRAPH_RECORDS_DIR), as the chain's one
 *             layer; its name and commits, unless the chain is anything
 *             else (filtered already, split, or not there)
 *   piece     commits [from, to) of the layer in date order, newest first (a
 *             commit's first parent is most often the next one, and they
 *             share most of their trees): each one's first-parent tree diff,
 *             its trees read from the repository's packs, as a filter;
 *             stopped at its budget, it says how far it got. Its file holds
 *             its filters sorted by graph position: a header of (position,
 *             length), then the filters
 *   assemble  the layer with every commit's filter, streamed a window of
 *             positions at a time (the filters are never held whole), as a
 *             new layer; the chain moved to it; the old layer and the
 *             pieces go
 *
 * A layer is written under a temporary name and renamed to its own (a pass
 * cut short leaves a read-only file another can replace), and the chain is
 * replaced as git replaces it (commit-graph.c): commit-graph-chain.lock
 * created exclusively, the chain checked under it, the lock renamed over the
 * chain. A lock this pass did not create is never removed: the pass leaves
 * the chain as it is and says why, as git does.
 *
 * Nothing holds a layer whole: a piece reads its CDAT chunk (36 bytes a
 * commit, and 12 for its date order), and holds a cache of trees, the pack
 * store's caches and its own filters (at most 640 bytes a commit); the
 * assembly, 16 bytes a commit and one window.
 */

import { ByteLru } from './byte-lru.js';
import {
  COMMIT_GRAPHS_DIR,
  COMMIT_GRAPH_CHAIN,
  GRAPH_RECORDS_DIR,
  bloomDataHeader,
  bloomFilter,
  changedPaths,
  chunkFileSize,
  chunkFileStream,
  cloneGraph,
  graphName,
  graphToc,
  graphTocBytes,
  isUnfilteredBase,
  layerCommits,
  type ChunkPlace,
  type LayerCommits,
  type StreamedChunk,
} from './commit-graph.js';
import { OID_BYTES, oidToHex, PackFormatError } from './format.js';
import { readRange } from './install.js';
import { PackObjectStore } from './store.js';
import type { CloneContext, CloneReceipt, CloneSupervisor, CloneWriter } from './clone.js';

/** A piece's decoded trees, shared by the commits it diffs. */
const TREE_CACHE_BYTES = 16 * 1024 * 1024;
/** The assembly reads and writes the filters this many bytes at a time. */
export const ASSEMBLY_WINDOW_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** What the pass needs of the session beyond a clone's calls: an exclusive create, and the lock's mode and removal. */
export interface GraphSupervisor extends CloneSupervisor {
  fsOpen(path: string, flags: { write: boolean; create: boolean; exclusive: boolean; mode: number }): Promise<{ id: number }>;
  fsWrite(handle: number, offset: number, bytes: Uint8Array): Promise<unknown>;
  fsClose(handle: number): Promise<unknown>;
  chmod(path: string, mode: number): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}

/** The wave writer's streamed file (@nimbus-sh/platform/wave-writer.js fileChunks): a layer is never held whole. */
export interface GraphWriter extends CloneWriter {
  fileChunks(path: string, mode: number, size: number, chunks: AsyncIterable<Uint8Array>): Promise<void>;
}

export interface GraphContext extends CloneContext {
  supervisor: GraphSupervisor;
  writer(onReceipts?: (receipts: CloneReceipt[]) => void): GraphWriter;
}

export interface FilterFile {
  name: string;
  bytes: number;
}

const join = (dir: string, path: string) => (dir.endsWith('/') ? dir + path : dir + '/' + path);
const LOCK = COMMIT_GRAPH_CHAIN + '.lock';
/** A layer being written, before it has its name. */
const TMP_LAYER_PREFIX = 'tmp_nimbus_graph_';
const TMP_FILTERS_PREFIX = 'tmp_filters_';
const filtersDir = (layer: string) => COMMIT_GRAPHS_DIR + '/' + TMP_FILTERS_PREFIX + layer;
const layerPath = (name: string) => COMMIT_GRAPHS_DIR + '/graph-' + name + '.graph';

/** The chain's layer names, oldest first; null when there is no chain. */
async function readChain(context: GraphContext): Promise<string[] | null> {
  const chain = await context.supervisor.fsReadRange(join(context.dir, COMMIT_GRAPH_CHAIN), 0, 64 * 1024);
  if (chain === null) return null;
  return decoder.decode(chain).split('\n').filter((line) => line.length > 0);
}

/** The chain's layer when it is exactly one: its name. */
async function soleLayer(context: GraphContext): Promise<string | null> {
  const names = await readChain(context);
  return names !== null && names.length === 1 && /^[0-9a-f]{40}$/.test(names[0]) ? names[0] : null;
}

/** A layer's place and table of contents: read, never the layer whole. */
interface LayerToc {
  path: string;
  chunks: ChunkPlace[];
}

async function layerToc(context: GraphContext, name: string): Promise<LayerToc> {
  const path = join(context.dir, layerPath(name));
  const head = await context.supervisor.fsReadRange(path, 0, 8);
  if (head === null || head.byteLength < 8) throw new PackFormatError('commit-graph layer ' + name + ' is missing');
  const toc = await readRange(context.supervisor, path, 0, graphTocBytes(head[6]));
  const end = Number(new DataView(toc.buffer, toc.byteOffset).getBigUint64(8 + head[6] * 12 + 4));
  return { path, chunks: graphToc(toc, end + OID_BYTES) };
}

/** One chunk of a layer, read whole. */
async function readChunk(context: GraphContext, toc: LayerToc, id: string): Promise<Uint8Array> {
  const place = toc.chunks.find((chunk) => chunk.id === id);
  if (place === undefined) throw new PackFormatError('a commit-graph layer has no ' + id + ' chunk');
  return await readRange(context.supervisor, toc.path, place.offset, place.size);
}

/** One chunk of a layer, read a window at a time. */
async function* chunkParts(context: GraphContext, toc: LayerToc, place: ChunkPlace, windowBytes: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < place.size; at += windowBytes) {
    yield await readRange(context.supervisor, toc.path, place.offset + at, Math.min(windowBytes, place.size - at));
  }
}

/** Why a pass leaves the chain as it is (network-facet.ts GraphFiltersOutcome). */
export type GraphSkip = 'no-graph' | 'not-a-base' | 'locked' | 'moved';

/**
 * The chain made `layer` alone, as git commits it: the lock created
 * exclusively (another's means another writer: the chain is left as it is),
 * the chain checked under it against `expected` (null: no chain), the lock
 * renamed over it. The lock, when it was this call's and is not the chain
 * now, goes.
 */
async function swapChain(context: GraphContext, expected: string | null, layer: string): Promise<GraphSkip | null> {
  const lock = join(context.dir, LOCK);
  let handle: number;
  try {
    // 0644 while it is written: the session refuses writes to a 0444 file, even through its creator's descriptor.
    handle = (await context.supervisor.fsOpen(lock, { write: true, create: true, exclusive: true, mode: 0o644 })).id;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 'EEXIST') return 'locked';
    throw error;
  }
  let committed = false;
  try {
    try {
      await context.supervisor.fsWrite(handle, 0, encoder.encode(layer + '\n'));
    } finally {
      await context.supervisor.fsClose(handle);
    }
    await context.supervisor.chmod(lock, 0o444);
    const chain = await readChain(context);
    const unchanged = expected === null ? chain === null : chain !== null && chain.length === 1 && chain[0] === expected;
    if (!unchanged) return 'moved';
    await context.supervisor.rename(lock, join(context.dir, COMMIT_GRAPH_CHAIN));
    committed = true;
    return null;
  } finally {
    if (!committed) await context.supervisor.unlink(lock).catch(() => undefined);
  }
}

/**
 * `write` makes the layer under a temporary name; it is then renamed to its
 * own, replacing whatever stands there (a pass cut short leaves a read-only
 * file of that name). Returns the name.
 */
async function installLayer(context: GraphContext, write: (path: string) => Promise<string>): Promise<string> {
  const tmp = COMMIT_GRAPHS_DIR + '/' + TMP_LAYER_PREFIX + crypto.randomUUID();
  const name = await write(tmp);
  await context.supervisor.rename(join(context.dir, tmp), join(context.dir, layerPath(name)));
  return name;
}

/** A file whole, its length unknown: ranged reads until one comes back short. */
async function readWhole(context: GraphContext, path: string): Promise<Uint8Array> {
  const PIECE = 4 * 1024 * 1024;
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const piece = await context.supervisor.fsReadRange(path, size, PIECE);
    if (piece === null) throw new PackFormatError(path + ' is missing');
    parts.push(piece);
    size += piece.byteLength;
    if (piece.byteLength < PIECE) break;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Everything in the repository-relative directory `dir`, and it; nothing when it is absent. */
async function removeDirectory(context: GraphContext, writer: CloneWriter, dir: string): Promise<void> {
  const names = await context.supervisor.readdir(join(context.dir, dir));
  if (names.length === 0) return;
  for (const name of names) await writer.remove(dir + '/' + name);
  await writer.remove(dir, true);
}

/**
 * What a pass that did not finish left: its temporary layers and its
 * pieces. Only a full clone starts a pass, one per repository, so what these
 * names hold is a pass's that is over.
 */
async function removeAbandoned(context: GraphContext, writer: CloneWriter): Promise<void> {
  for (const name of await context.supervisor.readdir(join(context.dir, COMMIT_GRAPHS_DIR))) {
    if (name.startsWith(TMP_LAYER_PREFIX)) await writer.remove(COMMIT_GRAPHS_DIR + '/' + name);
    else if (name.startsWith(TMP_FILTERS_PREFIX)) await removeDirectory(context, writer, COMMIT_GRAPHS_DIR + '/' + name);
  }
}

/**
 * A full clone's base layer, from the commit records its history left
 * (GRAPH_RECORDS_DIR), as the chain's one layer, if there is no chain; the
 * records go. Why it was not made the chain, when it was not.
 */
async function writeBaseLayer(context: GraphContext, writer: CloneWriter): Promise<GraphSkip | null> {
  const records = await context.supervisor.readdir(join(context.dir, GRAPH_RECORDS_DIR));
  if (records.length === 0) return null;
  let skipped: GraphSkip | null = null;
  if (await readChain(context) === null) {
    const lists: Uint8Array[] = [];
    for (const name of records) lists.push(await readWhole(context, join(context.dir, GRAPH_RECORDS_DIR + '/' + name)));
    const built = cloneGraph(lists);
    lists.length = 0;
    if (built !== null) {
      await writer.directory(COMMIT_GRAPHS_DIR);
      const name = await installLayer(context, async (tmp) => {
        await writer.file(tmp, 0o444, built.file);
        await writer.flush();
        return graphName(built.file);
      });
      skipped = await swapChain(context, null, name);
      if (skipped !== null && !(await readChain(context))?.includes(name)) await writer.remove(layerPath(name));
    }
  }
  await removeDirectory(context, writer, GRAPH_RECORDS_DIR);
  await writer.flush();
  return skipped;
}

/**
 * The layer to add filters to: a full clone's base layer, written first
 * from its records, or the chain's one layer if it has no filters yet; or
 * why there is none.
 */
export async function graphFiltersPlan(context: GraphContext): Promise<{ layer: string; commits: number } | { skipped: GraphSkip }> {
  const writer = context.writer();
  await removeAbandoned(context, writer);
  await writer.flush();
  const skipped = await writeBaseLayer(context, writer);
  if (skipped !== null) return { skipped };
  const layer = await soleLayer(context);
  if (layer === null) return { skipped: (await readChain(context)) === null ? 'no-graph' : 'not-a-base' };
  const toc = await layerToc(context, layer);
  if (!isUnfilteredBase(toc.chunks)) return { skipped: 'not-a-base' };
  return { layer, commits: toc.chunks.find(({ id }) => id === 'CDAT')!.size / (OID_BYTES + 16) };
}

/** The layer's commits in date order, newest first, ties in graph order. */
function dateOrder(commits: LayerCommits): Uint32Array {
  const order = Uint32Array.from({ length: commits.count }, (_, i) => i);
  const dates = Float64Array.from({ length: commits.count }, (_, i) => commits.date(i));
  return order.sort((a, b) => (dates[a] === dates[b] ? a - b : dates[b] - dates[a]));
}

/**
 * Filters for commits [from, to) of the layer's date order, until done or
 * past `budgetMs` of wall time, in one file: u32 count; count × (u32
 * position, u16 length), by position; the filters, in that order. Returns
 * where the next piece starts.
 */
export async function graphFiltersPiece(
  context: GraphContext,
  request: { layer: string; from: number; to: number; budgetMs: number },
): Promise<{ next: number; file: FilterFile | null; trees: number; treeBytes: number }> {
  const started = Date.now();
  const commits = layerCommits(await readChunk(context, await layerToc(context, request.layer), 'CDAT'));
  const order = dateOrder(commits);
  const store = new PackObjectStore({
    readRange: async (path, offset, length) => (await context.supervisor.fsReadRange(path, offset, length)) ?? new Uint8Array(0),
    readdir: (dir) => context.supervisor.readdir(dir),
  }, join(context.dir, '.git'));
  const cache = new ByteLru<string, Uint8Array>(TREE_CACHE_BYTES, TREE_CACHE_BYTES / 4);
  let trees = 0;
  let treeBytes = 0;
  const read = async (oid: Uint8Array): Promise<Uint8Array> => {
    const hex = oidToHex(oid);
    const cached = cache.get(hex);
    if (cached !== undefined) return cached;
    const object = await store.read(hex);
    if (object === null || object.type !== 'tree') throw new PackFormatError('the repository lacks tree ' + hex);
    trees++;
    treeBytes += object.data.byteLength;
    cache.set(hex, object.data);
    return object.data;
  };
  const filters = new Map<number, Uint8Array>();
  let next = request.from;
  const to = Math.min(request.to, commits.count);
  while (next < to && (next === request.from || Date.now() - started < request.budgetMs)) {
    const c = order[next++];
    const parent = commits.firstParent(c);
    filters.set(c, bloomFilter(await changedPaths(read, parent < 0 ? null : commits.tree(parent), commits.tree(c))));
  }
  if (filters.size === 0) return { next, file: null, trees, treeBytes };
  const positions = [...filters.keys()].sort((a, b) => a - b);
  let size = 4 + positions.length * 6;
  for (const filter of filters.values()) size += filter.byteLength;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, positions.length);
  let data = 4 + positions.length * 6;
  positions.forEach((position, i) => {
    const filter = filters.get(position)!;
    view.setUint32(4 + i * 6, position);
    view.setUint16(4 + i * 6 + 4, filter.byteLength);
    bytes.set(filter, data);
    data += filter.byteLength;
  });
  const name = 'piece-' + request.from + '-' + next;
  const writer = context.writer();
  await writer.directory(filtersDir(request.layer));
  await writer.file(filtersDir(request.layer) + '/' + name, 0o644, bytes);
  await writer.flush();
  return { next, file: { name, bytes: size }, trees, treeBytes };
}

/** A pass that did not finish: its pieces go, and the layer stays as it is. */
export async function graphFiltersDiscard(context: GraphContext, request: { layer: string }): Promise<null> {
  const writer = context.writer();
  await removeDirectory(context, writer, filtersDir(request.layer));
  await writer.flush();
  return null;
}

/** One piece file's index: its positions, in order, and where each one's filter starts in it. */
interface PieceIndex {
  path: string;
  positions: Uint32Array;
  /** offsets[i]: filter i's start in the file; offsets[count]: the file's end. */
  offsets: Uint32Array;
}

/** The first index of `positions` at or past `position`. */
function lowerBound(positions: Uint32Array, position: number): number {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid] < position) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The layer with every commit's filter, as a new layer the chain names; or
 * why the chain was left as it is. The pieces go either way.
 */
export async function graphFiltersAssemble(
  context: GraphContext,
  request: { layer: string; files: readonly FilterFile[]; windowBytes?: number },
): Promise<{ layer: string | null; skipped?: GraphSkip }> {
  const writer = context.writer();
  try {
    if (await soleLayer(context) !== request.layer) return { layer: null, skipped: 'moved' };
    const toc = await layerToc(context, request.layer);
    if (!isUnfilteredBase(toc.chunks)) return { layer: null, skipped: 'not-a-base' };
    const count = toc.chunks.find(({ id }) => id === 'CDAT')!.size / (OID_BYTES + 16);

    // Each piece's index, and every commit's filter length, from the pieces' headers.
    const lengths = new Int32Array(count).fill(-1);
    const pieces: PieceIndex[] = [];
    for (const file of request.files) {
      const path = join(context.dir, filtersDir(request.layer) + '/' + file.name);
      const n = new DataView((await readRange(context.supervisor, path, 0, 4)).buffer).getUint32(0);
      const header = await readRange(context.supervisor, path, 4, n * 6);
      const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const positions = new Uint32Array(n);
      const offsets = new Uint32Array(n + 1);
      offsets[0] = 4 + n * 6;
      for (let i = 0; i < n; i++) {
        const position = view.getUint32(i * 6);
        const length = view.getUint16(i * 6 + 4);
        if (position >= count || lengths[position] !== -1 || (i > 0 && position <= positions[i - 1])) {
          throw new PackFormatError('changed-path filter piece ' + file.name + ' names commit ' + position + ' out of turn');
        }
        positions[i] = position;
        lengths[position] = length;
        offsets[i + 1] = offsets[i] + length;
      }
      if (offsets[n] !== file.bytes) throw new PackFormatError('changed-path filter piece ' + file.name + ' is ' + file.bytes + ' bytes, not ' + offsets[n]);
      pieces.push({ path, positions, offsets });
    }
    const index = new Uint8Array(count * 4);
    const indexView = new DataView(index.buffer);
    let total = 0;
    for (let c = 0; c < count; c++) {
      if (lengths[c] === -1) throw new PackFormatError('commit ' + c + ' has no changed-path filter');
      total += lengths[c];
      indexView.setUint32(c * 4, total);
    }

    // The filters in graph order, a window of positions at a time: each
    // piece's run of them read in one range.
    const windowBytes = request.windowBytes ?? ASSEMBLY_WINDOW_BYTES;
    async function* filterData(): AsyncGenerator<Uint8Array> {
      for (let from = 0; from < count;) {
        let to = from;
        let bytes = 0;
        while (to < count && (to === from || bytes + lengths[to] <= windowBytes)) bytes += lengths[to++];
        const out = new Uint8Array(bytes);
        const startOf = (c: number) => (c === 0 ? 0 : indexView.getUint32((c - 1) * 4)) - (from === 0 ? 0 : indexView.getUint32((from - 1) * 4));
        for (const piece of pieces) {
          const lo = lowerBound(piece.positions, from);
          const hi = lowerBound(piece.positions, to);
          if (lo === hi) continue;
          const run = await readRange(context.supervisor, piece.path, piece.offsets[lo], piece.offsets[hi] - piece.offsets[lo]);
          for (let i = lo; i < hi; i++) {
            const at = piece.offsets[i] - piece.offsets[lo];
            out.set(run.subarray(at, at + lengths[piece.positions[i]]), startOf(piece.positions[i]));
          }
        }
        yield out;
        from = to;
      }
    }
    const streamed: StreamedChunk[] = [
      ...toc.chunks.map((place) => ({ id: place.id, size: place.size, parts: chunkParts(context, toc, place, windowBytes) })),
      { id: 'BIDX', size: index.byteLength, parts: [index] },
      { id: 'BDAT', size: 12 + total, parts: (async function* () { yield bloomDataHeader(); yield* filterData(); })() },
    ];
    const name = await installLayer(context, async (tmp) => {
      let named = '';
      await writer.fileChunks(tmp, 0o444, chunkFileSize(streamed), chunkFileStream(streamed, (name) => { named = name; }));
      await writer.flush();
      return named;
    });
    // The new layer whole, then the chain moved to it, then the old one
    // goes: the chain never names a layer that is not all there.
    const skipped = await swapChain(context, request.layer, name);
    if (skipped !== null) {
      if (!(await readChain(context))?.includes(name)) await writer.remove(layerPath(name));
      return { layer: null, skipped };
    }
    await writer.remove(layerPath(request.layer));
    return { layer: name };
  } finally {
    await removeDirectory(context, writer, filtersDir(request.layer));
    await writer.flush();
  }
}
