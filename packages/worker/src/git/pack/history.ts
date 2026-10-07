/**
 * git/pack/history.ts — a clone's full history, fetched in self-contained
 * pieces after its depth-1 worktree.
 *
 *   commits  every commit, no trees or blobs (filter tree:0); their root
 *            trees listed in pack order (newest first: neighbours share
 *            most of their trees), and each recorded for the clone's
 *            commit-graph (commit-graph.ts commitRecord)
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

import { commitRecord } from './commit-graph.js';
import { decodeBatch, parseTree, MODE_GITLINK, MODE_TREE } from './plan.js';
import { OID_BYTES, oidToHex, PackFormatError } from './format.js';
import {
  STAGE_DIR,
  commitTree,
  concat,
  join,
  readRange,
  resumePack,
  settledBefore,
  TagWatch,
  storePackResumable,
  type CloneContext,
  type CloneWriter,
  type PackSummary,
  type PendingPack,
  type StoredPack,
  type StorePackOptions,
} from './clone.js';
import { requestPack, type UploadPackOptions } from './upload-pack.js';

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

export interface StagedFile {
  name: string;
  bytes: number;
}

/** `snapshot`: a streamed clone's one pack, whose decoding continues here (clone.ts cloneStream). */
export type HistoryKind = 'commits' | 'trees' | 'blobs' | 'snapshot';

/** One history invocation's outcome: its pack (done or pending), and what it listed. */
export interface HistoryStepResult {
  kind: HistoryKind;
  pack: PackSummary | null;
  pending: PendingPack | null;
  /** Lists written (STAGE_DIR files): root trees for commits, blobs for trees. */
  lists: StagedFile[];
  /**
   * commits: the commits' records for the commit-graph (STAGE_DIR files;
   * commit-graph.ts commitRecord); null when one did not parse, which no
   * graph is written for, as git writes none.
   */
  graphLists?: StagedFile[] | null;
  /** Ids of the clone's tag interest this step's pack held (clone.ts TagWatch). */
  tagsFound?: string[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function transport(context: CloneContext): UploadPackOptions {
  return { url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress };
}

/** Collects one invocation's list records and writes them as one staged file. */
class ListWriter {
  /** A record could not be made (a commit that does not parse): the list is not written. */
  refused = false;

  private readonly parts: Uint8Array[] = [];
  private size = 0;

  add(bytes: Uint8Array): void {
    this.parts.push(bytes);
    this.size += bytes.byteLength;
  }

  async write(writer: CloneWriter, name: string): Promise<StagedFile[]> {
    if (this.size === 0 || this.refused) return [];
    const bytes = this.size;
    await writer.file(STAGE_DIR + '/' + name, 0o644, concat(this.parts));
    return [{ name, bytes }];
  }
}

/** What a kind of piece records as its objects resolve: `graph`, a commits piece's records for the commit-graph. */
function lister(kind: HistoryKind, list: ListWriter, graph: ListWriter): StorePackOptions['onObject'] {
  if (kind === 'commits') {
    return (object) => {
      if (object.type !== 'commit') return;
      list.add(hexBytes(commitTree(object.data, oidToHex(object.oid))));
      try {
        graph.add(commitRecord(object.oid, object.data));
      } catch (error) {
        if (!(error instanceof PackFormatError)) throw error;
        graph.refused = true;
      }
    };
  }
  if (kind === 'trees') {
    // Within one piece each blob is listed once; across pieces the plan dedupes.
    const seen = new Set<string>();
    return (object) => {
      if (object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === MODE_TREE || entry.mode === MODE_GITLINK) continue;
        const oid = object.data.subarray(entry.oidAt, entry.oidAt + OID_BYTES);
        const hex = oidToHex(oid);
        if (seen.has(hex)) continue;
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

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(OID_BYTES);
  for (let i = 0; i < OID_BYTES; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function settle(
  writer: CloneWriter,
  kind: HistoryKind,
  stored: StoredPack,
  list: ListWriter,
  graph: ListWriter,
  listName: string,
  watch: TagWatch,
): Promise<HistoryStepResult> {
  const lists = await list.write(writer, listName);
  const graphLists = graph.refused ? null : await graph.write(writer, 'graph-' + listName);
  await writer.flush();
  const tagsFound = [...watch.found];
  if ('pending' in stored) return { kind, pack: null, pending: stored.pending, lists, graphLists, tagsFound };
  return { kind, pack: stored.summary, pending: null, lists, graphLists, tagsFound };
}

/** What a piece records as its objects resolve, and which of the clone's tags' ids it meets. */
function watcher(kind: HistoryKind, list: ListWriter, graph: ListWriter, watch: TagWatch): StorePackOptions['onObject'] {
  const listed = lister(kind, list, graph);
  return (object) => {
    watch.see(object.type, object.oid);
    return listed?.(object);
  };
}

/** One piece of history: its request, its pack, its list. */
export async function historyStep(
  context: CloneContext,
  request: {
    jobId: string;
    kind: HistoryKind;
    /** A name unique to this piece, for its pack and lists. */
    piece: string;
    /** commits: the branch head. */
    head?: string;
    /** trees: a slice of a commits list (20-byte root trees); blobs: a batch file (20-byte ids). */
    source?: StagedFile & { offset?: number; length?: number };
    capabilities: readonly string[];
    /** Work units to decode before stopping (processor.ts WORK_BUDGET_UNITS by default). */
    budgetUnits?: number;
    /** The ids the clone's tags name or peel to (clone.ts TagWatch). */
    tagInterest?: readonly string[];
  },
): Promise<HistoryStepResult> {
  const writer = context.writer();
  writer.setPin(context.marker.path, context.marker.text, true);
  let wants: string[];
  let filter: string | undefined;
  if (request.kind === 'commits') {
    if (request.head === undefined) throw new PackFormatError('a commits piece needs the head');
    wants = [request.head];
    filter = 'tree:0';
  } else {
    const source = request.source;
    if (source === undefined) throw new PackFormatError('a ' + request.kind + ' piece needs its source');
    const bytes = await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/' + source.name), source.offset ?? 0, source.length ?? source.bytes);
    const unique = new Set<string>();
    for (let at = 0; at < bytes.byteLength; at += OID_BYTES) unique.add(oidToHex(bytes, at));
    wants = [...unique];
    filter = request.kind === 'trees' ? 'blob:none' : undefined;
  }
  const response = await requestPack(transport(context), new Set(request.capabilities), { wants, filter });
  if (response.pack === null) throw new PackFormatError('the server sent no pack for history piece ' + request.piece);
  const list = new ListWriter();
  const graph = new ListWriter();
  const watch = new TagWatch(request.tagInterest ?? []);
  const stored = await storePackResumable(context, writer, response.pack, 'tmp_pack_' + request.jobId + '_' + request.piece, {
    cacheBytes: HISTORY_CACHE_BYTES,
    recentBytes: HISTORY_RECENT_BYTES,
    budgetUnits: request.budgetUnits,
    onObject: watcher(request.kind, list, graph, watch),
  });
  return await settle(writer, request.kind, stored, list, graph, 'list-' + request.piece + '-0', watch);
}

/** A piece whose decoding stopped at the budget, continued from its stored pack. */
export async function historyResume(
  context: CloneContext,
  request: { kind: HistoryKind; piece: string; part: number; pending: PendingPack; budgetUnits?: number; tagInterest?: readonly string[] },
): Promise<HistoryStepResult> {
  // A resumed pack cannot be fetched again: a step run again after its
  // answer was lost finds the outcome it recorded before naming its pack.
  const recordName = 'settled-' + request.pending.tmpName;
  const settled = await settledBefore(context, request.pending.tmpName, recordName);
  if (settled !== null) {
    const extra = settled.extra as { lists: StagedFile[]; graphLists?: StagedFile[] | null; tagsFound: string[] };
    return { kind: request.kind, pack: settled.summary, pending: null, lists: extra.lists, graphLists: extra.graphLists === undefined ? [] : extra.graphLists, tagsFound: extra.tagsFound };
  }
  const writer = context.writer();
  writer.setPin(context.marker.path, context.marker.text, true);
  const list = new ListWriter();
  const graph = new ListWriter();
  const watch = new TagWatch(request.tagInterest ?? []);
  const listName = 'list-' + request.piece + '-' + request.part;
  let lists: StagedFile[] = [];
  let graphLists: StagedFile[] | null = [];
  const stored = await resumePack(context, writer, request.pending, {
    cacheBytes: HISTORY_CACHE_BYTES,
    recentBytes: HISTORY_RECENT_BYTES,
    budgetUnits: request.budgetUnits,
    onObject: watcher(request.kind, list, graph, watch),
    record: {
      name: recordName,
      publish: async () => ({
        lists: (lists = await list.write(writer, listName)),
        graphLists: (graphLists = graph.refused ? null : await graph.write(writer, 'graph-' + listName)),
        tagsFound: [...watch.found],
      }),
    },
  });
  if ('pending' in stored) return await settle(writer, request.kind, stored, list, graph, listName, watch);
  return { kind: request.kind, pack: stored.summary, pending: null, lists, graphLists, tagsFound: [...watch.found] };
}

/** An open-addressing set of 20-byte ids, each with a basename: the plan's only large structure. */
class BlobTable {
  oids = new Uint8Array(OID_BYTES * 1024);
  names = new Uint32Array(1024);
  /** Ids present already (the worktree's): kept out of every batch. */
  present = new Uint8Array(1024);
  count = 0;
  private slots = new Int32Array(1 << 12).fill(-1);
  readonly nameIds = new Map<string, number>();
  readonly nameList: string[] = [];

  add(oid: Uint8Array, at: number, name: string | null): void {
    const index = this.find(oid, at);
    if (index >= 0) return;
    if ((this.count + 1) * 2 > this.slots.length) this.rehash(this.slots.length * 2);
    if (this.count === this.names.length) this.grow();
    const n = this.count++;
    this.oids.set(oid.subarray(at, at + OID_BYTES), n * OID_BYTES);
    if (name === null) {
      this.present[n] = 1;
    } else {
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

  private hash(oid: Uint8Array, at: number): number {
    return ((oid[at] << 24) | (oid[at + 1] << 16) | (oid[at + 2] << 8) | oid[at + 3]) >>> 0;
  }

  private slotOf(oid: Uint8Array, at: number): number {
    const mask = this.slots.length - 1;
    let slot = this.hash(oid, at) & mask;
    while (this.slots[slot] >= 0 && !this.same(this.slots[slot], oid, at)) slot = (slot + 1) & mask;
    return slot;
  }

  private find(oid: Uint8Array, at: number): number {
    return this.slots[this.slotOf(oid, at)];
  }

  private same(index: number, oid: Uint8Array, at: number): boolean {
    const base = index * OID_BYTES;
    for (let i = 0; i < OID_BYTES; i++) if (this.oids[base + i] !== oid[at + i]) return false;
    return true;
  }

  private grow(): void {
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

  private rehash(size: number): void {
    this.slots = new Int32Array(size).fill(-1);
    for (let n = 0; n < this.count; n++) this.slots[this.slotOf(this.oids, n * OID_BYTES)] = n;
  }
}

/**
 * The blobs batches: every listed blob not already present, once, sorted by
 * basename. `present` are the worktree batch files (plan.ts encodeBatch).
 */
export async function historyPlan(
  context: CloneContext,
  request: { lists: StagedFile[]; present: StagedFile[]; blobsPerBatch?: number },
): Promise<{ batches: StagedFile[]; blobs: number; names: number }> {
  const table = new BlobTable();
  for (const file of request.present) {
    const bytes = await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/' + file.name), 0, file.bytes);
    for (const oid of decodeBatch(bytes).keys()) table.add(hexBytes(oid), 0, null);
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
  const order: number[] = [];
  for (let n = 0; n < table.count; n++) if (table.present[n] === 0) order.push(n);
  order.sort((a, b) => rank[table.names[a]] - rank[table.names[b]] || a - b);

  const perBatch = request.blobsPerBatch ?? BLOBS_PER_HISTORY_BATCH;
  const writer = context.writer();
  writer.setPin(context.marker.path, context.marker.text, true);
  const batches: StagedFile[] = [];
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
export function treeSlices(lists: readonly StagedFile[], commitsPerChunk = COMMITS_PER_CHUNK): (StagedFile & { offset: number; length: number })[] {
  const slices: (StagedFile & { offset: number; length: number })[] = [];
  const step = commitsPerChunk * OID_BYTES;
  for (const list of lists) {
    for (let offset = 0; offset < list.bytes; offset += step) {
      slices.push({ ...list, offset, length: Math.min(step, list.bytes - offset) });
    }
  }
  return slices;
}
