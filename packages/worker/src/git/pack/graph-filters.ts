/**
 * git/pack/graph-filters.ts — a full clone's commit-graph (commit-graph.ts),
 * written after the clone has answered, so nothing of it is on the way to
 * the prompt: its base layer first, then its changed-path filters, computed
 * in pieces and added to it, as `git commit-graph write --changed-paths`
 * would have written them.
 *
 *   plan      the base layer from the commit records the clone's history left
 *             (GRAPH_RECORDS_DIR), as the chain's one layer; its name and
 *             commits
 *   piece     commits [from, to) of the layer in date order, newest first (a
 *             commit's first parent is most often the next one, and they
 *             share most of their trees): each one's first-parent tree diff,
 *             its trees read from the repository's packs, as a filter;
 *             stopped at its budget, it says how far it got
 *   assemble  the filters in graph order, added to the layer as a new one;
 *             the chain names it if it still names the old one (a fetch may
 *             have layered on since: then the old layer stays as it is); the
 *             old layer and the pieces' files go
 *
 * A piece holds the layer (56 bytes a commit), a cache of trees, the pack
 * store's caches and its own filters (at most 640 bytes a commit).
 */

import { ByteLru } from './byte-lru.js';
import {
  COMMIT_GRAPHS_DIR,
  COMMIT_GRAPH_CHAIN,
  GRAPH_RECORDS_DIR,
  bloomFilter,
  changedPaths,
  cloneGraph,
  graphName,
  layerCommits,
  withFilters,
  type LayerCommits,
} from './commit-graph.js';
import { OID_BYTES, oidToHex, PackFormatError } from './format.js';
import { readRange } from './install.js';
import { PackObjectStore } from './store.js';
import type { CloneContext } from './clone.js';

/** A piece's decoded trees, shared by the commits it diffs. */
const TREE_CACHE_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface FilterFile {
  name: string;
  bytes: number;
}

const join = (dir: string, path: string) => (dir.endsWith('/') ? dir + path : dir + '/' + path);
const filtersDir = (layer: string) => COMMIT_GRAPHS_DIR + '/tmp_filters_' + layer;

/** The chain's layer when it is exactly one: its name. */
async function soleLayer(context: CloneContext): Promise<string | null> {
  const chain = await context.supervisor.fsReadRange(join(context.dir, COMMIT_GRAPH_CHAIN), 0, 4096);
  if (chain === null) return null;
  const names = decoder.decode(chain).split('\n').filter((line) => line.length > 0);
  return names.length === 1 && /^[0-9a-f]{40}$/.test(names[0]) ? names[0] : null;
}

/** A layer file, whole: its size from its chunk table's last offset. */
async function readLayer(context: CloneContext, name: string): Promise<Uint8Array> {
  const path = join(context.dir, COMMIT_GRAPHS_DIR + '/graph-' + name + '.graph');
  const head = await context.supervisor.fsReadRange(path, 0, 8);
  if (head === null || head.byteLength < 8) throw new PackFormatError('commit-graph layer ' + name + ' is missing');
  const end = await readRange(context.supervisor, path, 8 + head[6] * 12 + 4, 8);
  const size = Number(new DataView(end.buffer, end.byteOffset).getBigUint64(0)) + OID_BYTES;
  const file = await readRange(context.supervisor, path, 0, size);
  if (graphName(file) !== name) throw new PackFormatError('commit-graph layer ' + name + ' does not hash to its name');
  return file;
}

/** A file whole, its length unknown: ranged reads until one comes back short. */
async function readWhole(context: CloneContext, path: string): Promise<Uint8Array> {
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

/**
 * A full clone's base layer, from the commit records its history left
 * (GRAPH_RECORDS_DIR), as the chain's one layer; the records go. None when
 * the repository has a graph already, or the records make none.
 */
async function writeBaseLayer(context: CloneContext): Promise<void> {
  const names = await context.supervisor.readdir(join(context.dir, GRAPH_RECORDS_DIR));
  if (names.length === 0) return;
  const writer = context.writer();
  if (await context.supervisor.fsReadRange(join(context.dir, COMMIT_GRAPH_CHAIN), 0, 1) === null) {
    const lists: Uint8Array[] = [];
    for (const name of names) lists.push(await readWhole(context, join(context.dir, GRAPH_RECORDS_DIR + '/' + name)));
    const built = cloneGraph(lists);
    if (built !== null) {
      const name = graphName(built.file);
      await writer.directory(COMMIT_GRAPHS_DIR);
      await writer.file(COMMIT_GRAPHS_DIR + '/graph-' + name + '.graph', 0o444, built.file);
      await writer.file(COMMIT_GRAPH_CHAIN, 0o444, encoder.encode(name + '\n'));
    }
  }
  for (const name of names) await writer.remove(GRAPH_RECORDS_DIR + '/' + name);
  await writer.remove(GRAPH_RECORDS_DIR, true);
  await writer.flush();
}

/**
 * The layer to add filters to: a full clone's base layer, written first
 * from its records; or the chain's one layer, if it has no filters yet.
 */
export async function graphFiltersPlan(context: CloneContext): Promise<{ layer: string; commits: number } | null> {
  await writeBaseLayer(context);
  const layer = await soleLayer(context);
  if (layer === null) return null;
  const file = await readLayer(context, layer);
  try {
    const commits = layerCommits(file);
    return { layer, commits: commits.count };
  } catch (error) {
    // Already filtered, or not a base layer: nothing to add.
    if (error instanceof PackFormatError) return null;
    throw error;
  }
}

/** The layer's commits in date order, newest first, ties in graph order. */
function dateOrder(commits: LayerCommits): Uint32Array {
  const order = Uint32Array.from({ length: commits.count }, (_, i) => i);
  const dates = Array.from({ length: commits.count }, (_, i) => commits.date(i));
  return order.sort((a, b) => (dates[a] === dates[b] ? a - b : dates[a] > dates[b] ? -1 : 1));
}

/**
 * Filters for commits [from, to) of the layer's date order, until done or
 * past `budgetMs` of wall time; their records (position u32, length u16,
 * filter) in one file. Returns where the next piece starts.
 */
export async function graphFiltersPiece(
  context: CloneContext,
  request: { layer: string; from: number; to: number; budgetMs: number },
): Promise<{ next: number; file: FilterFile | null; trees: number; treeBytes: number }> {
  const started = Date.now();
  const commits = layerCommits(await readLayer(context, request.layer));
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
  const parts: Uint8Array[] = [];
  let size = 0;
  let next = request.from;
  const to = Math.min(request.to, commits.count);
  while (next < to && (next === request.from || Date.now() - started < request.budgetMs)) {
    const c = order[next++];
    const parent = commits.firstParent(c);
    const filter = bloomFilter(await changedPaths(read, parent < 0 ? null : commits.tree(parent), commits.tree(c)));
    const record = new Uint8Array(6 + filter.byteLength);
    const view = new DataView(record.buffer);
    view.setUint32(0, c);
    view.setUint16(4, filter.byteLength);
    record.set(filter, 6);
    parts.push(record);
    size += record.byteLength;
  }
  if (size === 0) return { next, file: null, trees, treeBytes };
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  const name = 'piece-' + request.from + '-' + next;
  const writer = context.writer();
  await writer.directory(filtersDir(request.layer));
  await writer.file(filtersDir(request.layer) + '/' + name, 0o644, bytes);
  await writer.flush();
  return { next, file: { name, bytes: size }, trees, treeBytes };
}

/** A pass that did not finish: its pieces' files go, and the layer stays as it is. */
export async function graphFiltersDiscard(context: CloneContext, request: { layer: string }): Promise<null> {
  const writer = context.writer();
  const dir = filtersDir(request.layer);
  const names = await context.supervisor.readdir(join(context.dir, dir));
  for (const name of names) await writer.remove(dir + '/' + name);
  if (names.length > 0) await writer.remove(dir, true);
  await writer.flush();
  return null;
}

/**
 * The layer, with every commit's filter, as a new layer the chain names;
 * null when the chain no longer names the old one alone (the pieces' files
 * go either way).
 */
export async function graphFiltersAssemble(
  context: CloneContext,
  request: { layer: string; files: readonly FilterFile[] },
): Promise<{ layer: string | null }> {
  const writer = context.writer();
  const dir = filtersDir(request.layer);
  let written: string | null = null;
  if (await soleLayer(context) === request.layer) {
    const file = await readLayer(context, request.layer);
    const filters: (Uint8Array | undefined)[] = new Array(layerCommits(file).count);
    for (const piece of request.files) {
      const bytes = await readRange(context.supervisor, join(context.dir, dir + '/' + piece.name), 0, piece.bytes);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let at = 0; at < bytes.byteLength;) {
        const position = view.getUint32(at);
        const length = view.getUint16(at + 4);
        filters[position] = bytes.subarray(at + 6, at + 6 + length);
        at += 6 + length;
      }
    }
    if (filters.some((filter) => filter === undefined)) throw new PackFormatError('a commit has no changed-path filter');
    const filtered = withFilters(file, filters as Uint8Array[]);
    written = graphName(filtered);
    await writer.file(COMMIT_GRAPHS_DIR + '/graph-' + written + '.graph', 0o444, filtered);
    await writer.file(COMMIT_GRAPH_CHAIN, 0o444, encoder.encode(written + '\n'));
    await writer.remove(COMMIT_GRAPHS_DIR + '/graph-' + request.layer + '.graph');
  }
  const names = await context.supervisor.readdir(join(context.dir, dir));
  for (const name of names) await writer.remove(dir + '/' + name);
  if (names.length > 0) await writer.remove(dir, true);
  await writer.flush();
  return { layer: written };
}
