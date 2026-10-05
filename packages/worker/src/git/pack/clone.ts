/**
 * git/pack/clone.ts — a shallow clone in one pass per object, in parallel
 * batches, written straight into the session.
 *
 * prepare (one invocation): discover the remote; fetch the commit and its
 *   trees with `filter blob:none` (Linux: 3.1 MB); store that pack and its
 *   idx; plan the checkout from the trees; write the repository's metadata
 *   (config, HEAD, refs, shallow) and one batch file per run of blobs.
 * batch (K invocations, concurrently): fetch a batch's blobs by id; as each
 *   blob is resolved write it at each of its paths through the wave writer;
 *   store the batch's pack and idx; keep its share of the index, built from
 *   the stat the session reports for each file it published.
 * finish (one invocation): assemble the index from the batches' shares.
 *
 * Every pack arrives once, is decoded once, and is stored as it arrives;
 * nothing reads it back but a delta whose base has left the cache.
 */

import { decodeBatch, encodeBatch, parseTree, CheckoutPlan, MODE_GITLINK, MODE_SYMLINK, MODE_TREE } from './plan.js';
import { encodeIdxV2, ENTRY_BYTES, entryOffset } from './idx.js';
import { ByteLru } from './byte-lru.js';
import { MissingBaseError, PackObjectResolver, runAsync } from './reader.js';
import { encodeIndex, encodeIndexEntry, splitIndexEntries, type IndexStat } from './index-file.js';
import { encodeNode, type BuiltSubtree } from '../worktree/cachetree.js';
import { oidFromHex, oidToHex, PACK_TRAILER_BYTES, PackFormatError } from './format.js';
import { PackStreamProcessor, type PackProcessResult, type PackStore, type WorkTally } from './processor.js';
import { discover, requestPack, type Advertisement, type GitTransportAuth } from './upload-pack.js';

/** The supervisor calls a clone makes beyond its wave writer's. */
export interface CloneSupervisor {
  fsWriteRange(path: string, offset: number, bytes: Uint8Array): Promise<unknown>;
  fsTruncate(path: string, size: number): Promise<unknown>;
  fsReadRange(path: string, offset: number, length: number): Promise<Uint8Array | null>;
  rename(from: string, to: string): Promise<unknown>;
  /** Names in a directory, [] when it is absent. */
  readdir(path: string): Promise<string[]>;
}

/** The wave writer's surface (git/wave-writer.ts), as a clone uses it. */
export interface CloneWriter {
  file(path: string, mode: number, bytes: Uint8Array): Promise<void>;
  symlink(path: string, target: string): Promise<void>;
  directory(path: string): Promise<void>;
  remove(path: string, directory?: boolean): Promise<void>;
  setPin(path: string, text: string, durable?: boolean): void;
  flush(): Promise<void>;
}

export interface CloneReceipt extends IndexStat {
  path: string;
}

export interface CloneContext {
  supervisor: CloneSupervisor;
  /** A wave writer rooted at the clone; `onReceipts` sees each published wave's files. */
  writer(onReceipts?: (receipts: CloneReceipt[]) => void): CloneWriter;
  /** The worktree's VFS path; record paths are relative to it. */
  dir: string;
  url: string;
  auth?: GitTransportAuth;
  /** The ownership marker every wave re-asserts (repo-relative path). */
  marker: { path: string; text: string };
  onProgress?(text: string): void;
  fetch?: typeof fetch;
}

export interface CloneRequest {
  ref?: string;
  depth: number;
  jobId: string;
  /** `git clone --filter=<spec>`, normalized (blob:limit in bytes). */
  filter?: string;
  /** Blobs per batch; the default suits a 30 s invocation (BLOBS_PER_BATCH). */
  blobsPerBatch?: number;
}

export interface CloneBatchPlan {
  index: number;
  blobs: number;
  paths: number;
  /** Its batch file's length (STAGE_DIR/batch-<index>). */
  bytes: number;
}

export interface ClonePrepared {
  commit: string;
  tree: string;
  /** Branch HEAD names, or null for a detached HEAD (a tag). */
  headRef: string | null;
  capabilities: string[];
  batches: CloneBatchPlan[];
  /** Plan entries, gitlinks included, and the plan's bytes in memory. */
  planEntries: number;
  planBytes: number;
  /** The index entries prepare wrote (gitlinks, a blob:limit pack's blobs): STAGE_DIR files. */
  shares: { name: string; bytes: number }[];
  /** The index's TREE extension, staged as STAGE_DIR/cache-tree. */
  cacheTreeBytes: number;
  /** A partial clone (--filter): every pack it stores is a promisor pack. */
  partial: boolean;
  packs: PackSummary[];
}

export interface PackSummary {
  packSha: string;
  packBytes: number;
  objects: number;
  work: WorkTally;
}

export interface CloneBatchResult {
  index: number;
  blobs: number;
  files: number;
  indexBytes: number;
  pack: PackSummary;
}

/** Why the fast path cannot serve this clone: the caller takes the single-stream path. */
export interface CloneUnsupported {
  unsupported: string;
}

export const STAGE_DIR = '.git/nimbus-clone';
export const PACK_DIR = '.git/objects/pack';
/** Blobs per batch, and at most this many batches. */
const BLOBS_PER_BATCH = 2_500;
const MAX_BATCHES = 16;
/** A batch facet's delta-base cache: blob batches carry few deltas. */
const BATCH_CACHE_BYTES = 4 * 1024 * 1024;
/** Trees a prepare holds to plan from; a shallow tree set is a few MB. */
const PLAN_TREE_BYTES = 48 * 1024 * 1024;
/**
 * Store reads one invocation makes before it stops decoding and leaves the
 * rest to a continuation: each is a supervisor RPC, a subrequest. A react
 * history batch (18 MB pack) made enough to hit "Too many subrequests by
 * single Worker invocation"; an invocation's other RPCs (appends at 448 KiB,
 * waves) stay well under a few hundred more.
 */
const MAX_STORE_READS = 400;

/** Blobs held while a filtered pack's trees are still arriving. */
const HELD_BLOB_BYTES = 16 * 1024 * 1024;
const READ_PIECE_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** A pack stored as it arrives, by ranged writes the clone's lease covers. */
class SupervisorPackStore implements PackStore {
  size = 0;

  constructor(private readonly supervisor: CloneSupervisor, readonly path: string) {}

  async append(bytes: Uint8Array): Promise<void> {
    const at = this.size;
    this.size += bytes.byteLength;
    await this.supervisor.fsWriteRange(this.path, at, bytes);
  }

  async writeAt(offset: number, bytes: Uint8Array): Promise<void> {
    await this.supervisor.fsWriteRange(this.path, offset, bytes);
  }

  async truncate(size: number): Promise<void> {
    this.size = size;
    await this.supervisor.fsTruncate(this.path, size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return await readRange(this.supervisor, this.path, offset, length);
  }
}

export async function readRange(supervisor: CloneSupervisor, path: string, offset: number, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  for (let at = 0; at < length; at += READ_PIECE_BYTES) {
    const want = Math.min(READ_PIECE_BYTES, length - at);
    const piece = await supervisor.fsReadRange(path, offset + at, want);
    if (piece === null || piece.byteLength !== want) {
      throw new PackFormatError(path + ': range ' + (offset + at) + '+' + want + ' came back ' + (piece === null ? 'missing' : piece.byteLength + ' bytes'));
    }
    out.set(piece, at);
  }
  return out;
}

export function join(dir: string, path: string): string {
  return dir + '/' + path;
}

function stripSlash(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

/** The ref a clone checks out, and the objects that name it. */
function resolveRef(advertisement: Advertisement, ref: string | undefined): { fullRef: string; commit: string; tagObject: string | null } {
  const candidates = ref === undefined
    ? [advertisement.symrefs.get('HEAD') ?? 'HEAD']
    : ref.startsWith('refs/') ? [ref] : ['refs/heads/' + ref, 'refs/tags/' + ref];
  for (const fullRef of candidates) {
    const oid = advertisement.refs.get(fullRef);
    if (oid === undefined) continue;
    const peeled = advertisement.refs.get(fullRef + '^{}');
    return { fullRef, commit: peeled ?? oid, tagObject: peeled === undefined ? null : oid };
  }
  throw new Error('fatal: Remote branch ' + (ref ?? 'HEAD') + ' not found in upstream origin');
}

function shortName(fullRef: string): string {
  return fullRef.replace(/^refs\/(heads|tags)\//, '');
}

/** The config `git clone --depth N [--filter=<spec>]` writes. */
function cloneConfig(url: string, fullRef: string, filter: string | undefined): string {
  const branch = fullRef.startsWith('refs/heads/') ? shortName(fullRef) : null;
  // A partial clone's repository is format 1 (extensions); git sets it so.
  let config = '[core]\n\trepositoryformatversion = ' + (filter === undefined ? 0 : 1) +
    '\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n' +
    '[remote "origin"]\n\turl = ' + url + '\n';
  config += branch === null
    ? '\tfetch = +' + fullRef + ':' + fullRef + '\n'
    : '\tfetch = +refs/heads/' + branch + ':refs/remotes/origin/' + branch + '\n';
  if (filter !== undefined) config += '\tpromisor = true\n\tpartialclonefilter = ' + filter + '\n';
  if (branch !== null) config += '[branch "' + branch + '"]\n\tremote = origin\n\tmerge = refs/heads/' + branch + '\n';
  return config;
}

/**
 * Store a pack stream: process it, name the pack by its id, write its idx
 * last (as git does). `promisor` is the pack's .promisor file, written
 * before the idx when the clone is partial: what git writes, the refs or
 * ids the fetch asked for, one "<id> <name>" line each.
 */
async function storePack(
  context: CloneContext,
  writer: CloneWriter,
  stream: AsyncIterable<Uint8Array>,
  tmpName: string,
  options: StorePackOptions,
): Promise<{ result: PackProcessResult; summary: PackSummary }> {
  // A clone's batches cannot resume: their reads are not capped.
  const stored = await storePackResumable(context, writer, stream, tmpName, { maxStoreReads: Number.POSITIVE_INFINITY, ...options });
  if ('pending' in stored) {
    // A clone's batches are sized to decode within one invocation's budget.
    throw new PackFormatError('pack ' + tmpName + ' ran past its decoding budget after ' + stored.pending.decoded + ' entries');
  }
  return stored;
}

export interface StorePackOptions {
  cacheBytes?: number;
  recentBytes?: number;
  budgetUnits?: number;
  maxStoreReads?: number;
  onObject?: ConstructorParameters<typeof PackStreamProcessor>[0]['onObject'];
  promisor?: string;
}

/**
 * A pack whose decoding ran past the invocation's budget: stored whole as
 * `tmpName`, its idx records so far in STAGE_DIR/ckpt-<tmpName>. Plain
 * data: it travels in the facet's result to the next invocation.
 */
export interface PendingPack {
  tmpName: string;
  packBytes: number;
  offset: number;
  decoded: number;
  recordsBytes: number;
  externalBases: string[];
  promisor?: string;
}

export type StoredPack = { result: PackProcessResult; summary: PackSummary } | { pending: PendingPack };

/** storePack, or where its decoding stopped when the budget ran out first (see resumePack). */
export async function storePackResumable(
  context: CloneContext,
  writer: CloneWriter,
  stream: AsyncIterable<Uint8Array>,
  tmpName: string,
  options: StorePackOptions,
): Promise<StoredPack> {
  const store = new SupervisorPackStore(context.supervisor, join(context.dir, PACK_DIR + '/' + tmpName));
  const result = await new PackStreamProcessor({
    store,
    cacheBytes: options.cacheBytes,
    recentBytes: options.recentBytes,
    budgetUnits: options.budgetUnits,
    maxStoreReads: options.maxStoreReads ?? MAX_STORE_READS,
    onObject: options.onObject,
  }).run(stream);
  return await settlePack(context, writer, tmpName, result, options.promisor);
}

/** Continue decoding a pending pack from its stored bytes; it may stop at the budget again. */
export async function resumePack(
  context: CloneContext,
  writer: CloneWriter,
  pending: PendingPack,
  options: Omit<StorePackOptions, 'promisor'>,
): Promise<StoredPack> {
  const store = new SupervisorPackStore(context.supervisor, join(context.dir, PACK_DIR + '/' + pending.tmpName));
  store.size = pending.packBytes;
  const records = await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/ckpt-' + pending.tmpName), 0, pending.recordsBytes);
  const result = await new PackStreamProcessor({
    store,
    cacheBytes: options.cacheBytes,
    recentBytes: options.recentBytes,
    budgetUnits: options.budgetUnits,
    maxStoreReads: options.maxStoreReads ?? MAX_STORE_READS,
    onObject: options.onObject,
  }).resume({ offset: pending.offset, decoded: pending.decoded, records, externalBases: pending.externalBases }, pending.packBytes);
  return await settlePack(context, writer, pending.tmpName, result, pending.promisor);
}

/** Name a fully decoded pack and write its idx (and .promisor); or checkpoint it. */
async function settlePack(
  context: CloneContext,
  writer: CloneWriter,
  tmpName: string,
  result: PackProcessResult,
  promisor: string | undefined,
): Promise<StoredPack> {
  if (result.checkpoint !== null || result.entries === null) {
    const checkpoint = result.checkpoint!;
    const recordsBytes = checkpoint.records.byteLength;
    await writer.file(STAGE_DIR + '/ckpt-' + tmpName, 0o644, checkpoint.records);
    await writer.flush();
    return {
      pending: {
        tmpName,
        packBytes: result.packBytes,
        offset: checkpoint.offset,
        decoded: checkpoint.decoded,
        recordsBytes,
        externalBases: checkpoint.externalBases,
        ...(promisor === undefined ? {} : { promisor }),
      },
    };
  }
  const packSha = oidToHex(result.packSha);
  await context.supervisor.rename(join(context.dir, PACK_DIR + '/' + tmpName), join(context.dir, PACK_DIR + '/pack-' + packSha + '.pack'));
  if (promisor !== undefined) {
    await writer.file(PACK_DIR + '/pack-' + packSha + '.promisor', 0o644, encoder.encode(promisor));
  }
  const pieces: Uint8Array[] = [];
  const entries = result.entries;
  for await (const piece of encodeIdxV2(result.objects, result.packSha, async function* () { yield entries; })) pieces.push(piece);
  await writer.file(PACK_DIR + '/pack-' + packSha + '.idx', 0o644, concat(pieces));
  return { result, summary: { packSha, packBytes: result.packBytes, objects: result.objects, work: result.work } };
}

/** The tree id a commit object names. */
export function commitTree(commit: Uint8Array, oid: string): string {
  const line = /^tree ([0-9a-f]{40})\n/.exec(decoder.decode(commit.subarray(0, 46)));
  if (!line) throw new PackFormatError('commit ' + oid + ' names no tree');
  return line[1];
}

/** The cache tree of `root`, as written: each tree's id and how many index entries it covers. */
function cacheTreeOf(name: string, root: string, trees: Map<string, Uint8Array>): { built: BuiltSubtree; count: number } {
  const data = trees.get(root);
  if (data === undefined) throw new PackFormatError('the pack lacks tree ' + root);
  let count = 0;
  const subtrees: BuiltSubtree[] = [];
  for (const entry of parseTree(data)) {
    if (entry.mode !== MODE_TREE) {
      count++;
      continue;
    }
    const child = cacheTreeOf(entry.name, oidToHex(data, entry.oidAt), trees);
    count += child.count;
    subtrees.push(child.built);
  }
  return { built: encodeNode(name, count, root, subtrees), count };
}

/** Every tree below `root` is in `trees`. */
function treesComplete(trees: Map<string, Uint8Array>, root: string): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const data = trees.get(pending.pop()!);
    if (data === undefined) return false;
    for (const entry of parseTree(data)) if (entry.mode === MODE_TREE) pending.push(oidToHex(data, entry.oidAt));
  }
  return true;
}

/**
 * The clone's metadata, its commit and trees, and its plan; or why the
 * server cannot serve the fast path.
 *
 * Without --filter prepare asks for blob:none and every blob comes in the
 * batches. With one, prepare asks for the user's filter: a blob:limit pack
 * also carries the small blobs, written at their paths as they arrive (a
 * pack's trees precede its blobs), and a tree:<depth> pack lacks deep trees,
 * which one more blob:none request for the root tree brings, as git's lazy
 * fetch would. Every pack of a partial clone is a promisor pack.
 */
export async function cloneFast(context: CloneContext, request: CloneRequest): Promise<ClonePrepared | CloneUnsupported> {
  const transport = { url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress };
  const advertisement = await discover(transport);
  const capabilities = advertisement.capabilities;
  if (!capabilities.has('filter')) {
    if (request.filter !== undefined) throw new Error('fatal: the server does not support --filter');
    return { unsupported: 'the server does not offer filter' };
  }
  if (!capabilities.has('allow-reachable-sha1-in-want') && !capabilities.has('allow-any-sha1-in-want')) {
    return { unsupported: 'the server does not take wants by object id' };
  }
  if (advertisement.refs.size === 0) return { unsupported: 'the remote is empty' };
  const { fullRef, commit, tagObject } = resolveRef(advertisement, request.ref);
  const partial = request.filter !== undefined;

  const writer = context.writer();
  writer.setPin(context.marker.path, context.marker.text, true);
  for (const dir of ['.git/hooks', '.git/info', '.git/objects/info', PACK_DIR, '.git/refs/heads', '.git/refs/tags', STAGE_DIR]) {
    await writer.directory(dir);
  }
  await writer.flush();

  const response = await requestPack(transport, capabilities, {
    wants: tagObject === null ? [commit] : [tagObject],
    depth: request.depth,
    filter: request.filter ?? 'blob:none',
  });
  if (response.pack === null) throw new PackFormatError('the server sent no pack for the commit');
  const trees = new Map<string, Uint8Array>();
  let treeBytes = 0;
  let commitObject: Uint8Array | null = null;
  let plan: CheckoutPlan | null = null;
  let planBlobs: Map<string, number[]> | null = null;
  // Blobs a blob:limit pack carries, written as they arrive with their index entries.
  const arrived = new Set<string>();
  const inline: { path: string; mode: number; oid: Uint8Array }[] = [];
  const receipts = new Map<string, IndexStat>();
  let blobWriter: CloneWriter | null = null;
  const keepTree = (hex: string, data: Uint8Array): void => {
    treeBytes += data.byteLength;
    if (treeBytes > PLAN_TREE_BYTES) throw new PackFormatError('the commit\'s trees pass ' + PLAN_TREE_BYTES + ' bytes');
    trees.set(hex, data);
  };
  const planFrom = (): CheckoutPlan => {
    if (commitObject === null) throw new PackFormatError('the pack lacks commit ' + commit);
    const root = trees.get(commitTree(commitObject, commit));
    if (root === undefined) throw new PackFormatError('the pack lacks the commit\'s tree');
    return CheckoutPlan.fromTrees(root, (data, at) => {
      const found = trees.get(oidToHex(data, at));
      if (found === undefined) throw new PackFormatError('the pack lacks tree ' + oidToHex(data, at));
      return found;
    });
  };
  const head = tagObject ?? commit;
  const promisorRefs = head + ' HEAD\n' + head + ' ' + fullRef + '\n';
  // A blob that arrives before the checkout's trees are all in (git's write
  // order puts trees first, but a filtered pack need not) is held, to a
  // budget, and past it left in the stored pack to be read back by offset.
  const held = new Map<string, Uint8Array>();
  let heldBytes = 0;
  const deferred = new Set<string>();
  let plannable: boolean | null = null;
  const emit = async (hex: string, oid: Uint8Array, data: Uint8Array): Promise<void> => {
    const entries = planBlobs!.get(hex);
    if (entries === undefined || arrived.has(hex)) return;
    arrived.add(hex);
    if (blobWriter === null) {
      blobWriter = context.writer((published) => {
        for (const receipt of published) receipts.set(stripSlash(receipt.path), receipt);
      });
      blobWriter.setPin(context.marker.path, context.marker.text, true);
    }
    for (const entry of entries) {
      const path = plan!.path(entry);
      const mode = plan!.mode(entry);
      if (mode === MODE_SYMLINK) await blobWriter.symlink(path, decoder.decode(data));
      else await blobWriter.file(path, mode, data.slice());
      inline.push({ path, mode, oid });
    }
  };
  const { result: prepareResult, summary } = await storePack(context, writer, response.pack, 'tmp_pack_' + request.jobId + '_trees', {
    promisor: partial ? promisorRefs : undefined,
    async onObject(object) {
      const hex = oidToHex(object.oid);
      if (object.type === 'tree') keepTree(hex, object.data);
      else if (object.type === 'commit' && hex === commit) commitObject = object.data;
      else if (object.type === 'blob') {
        plannable ??= commitObject !== null && treesComplete(trees, commitTree(commitObject, commit));
        if (plannable && plan === null) {
          plan = planFrom();
          planBlobs = plan.blobPaths();
        }
        if (plan !== null) await emit(hex, object.oid, object.data);
        else if (heldBytes + object.data.byteLength <= HELD_BLOB_BYTES) {
          held.set(hex, object.data.slice());
          heldBytes += object.data.byteLength;
        } else deferred.add(hex);
      }
    },
  });
  if (commitObject === null) throw new PackFormatError('the pack lacks commit ' + commit);
  const tree = commitTree(commitObject, commit);
  const packs = [summary];
  if (plan === null && !treesComplete(trees, tree)) {
    // tree:<depth> stopped short of the checkout's trees: fetch them all, no blobs.
    const more = await requestPack(transport, capabilities, { wants: [tree], filter: 'blob:none' });
    if (more.pack === null) throw new PackFormatError('the server sent no pack for tree ' + tree);
    const { summary: treesPack } = await storePack(context, writer, more.pack, 'tmp_pack_' + request.jobId + '_tree', {
      promisor: partial ? tree + ' ' + tree + '\n' : undefined,
      onObject(object) {
        if (object.type === 'tree') keepTree(oidToHex(object.oid), object.data);
      },
    });
    packs.push(treesPack);
  }
  if (plan === null) {
    plan = planFrom();
    planBlobs = plan.blobPaths();
  }
  // The index's TREE extension, as git clone writes it: a fresh checkout's
  // entries are exactly the commit's tree, so every node is valid and the
  // first status compares no tree.
  const cacheTree = cacheTreeOf('', tree, trees).built.bytes;
  trees.clear();
  for (const [hex, data] of held) await emit(hex, oidFromHex(hex), data);
  held.clear();
  if (deferred.size > 0) {
    const resolver = new PackObjectResolver({
      file: join(context.dir, PACK_DIR + '/pack-' + summary.packSha + '.pack'),
      dataEnd: summary.packBytes - PACK_TRAILER_BYTES,
      cache: new ByteLru(BATCH_CACHE_BYTES),
      refBase: (oid) => { throw new MissingBaseError(oid); },
    });
    const records = prepareResult.entries!;
    for (let i = 0; i * ENTRY_BYTES < records.byteLength; i++) {
      const hex = oidToHex(records, i * ENTRY_BYTES);
      if (!deferred.has(hex)) continue;
      const object = await runAsync(resolver.objectAt(entryOffset(records, i)), (range) =>
        readRange(context.supervisor, range.file, range.offset, range.length));
      await emit(hex, oidFromHex(hex), object.data);
    }
  }

  const shares: { name: string; bytes: number }[] = [];
  if (blobWriter !== null) {
    await (blobWriter as CloneWriter).flush();
    const share = concat(inline.map(({ path, mode, oid }) => {
      const stat = receipts.get(stripSlash(join(context.dir, path)));
      if (stat === undefined) throw new PackFormatError('no receipt for ' + path);
      return encodeIndexEntry(path, mode, oid, stat);
    }));
    shares.push({ name: 'index-prepare', bytes: share.byteLength });
    await writer.file(STAGE_DIR + '/index-prepare', 0o644, share);
  }

  const batches = plan.batches(Math.min(MAX_BATCHES, Math.ceil(plan.count / (request.blobsPerBatch ?? BLOBS_PER_BATCH))), arrived);
  const batchPlans: CloneBatchPlan[] = [];
  for (const batch of batches) {
    // The writer takes the bytes (W7 may detach them): measure first.
    const encoded = encodeBatch(plan, batch);
    batchPlans.push({
      index: batch.index,
      blobs: batch.blobs.length,
      paths: batch.blobs.reduce((n, blob) => n + blob.entries.length, 0),
      bytes: encoded.byteLength,
    });
    await writer.file(STAGE_DIR + '/batch-' + batch.index, 0o644, encoded);
  }
  // Gitlinks are checked out as empty directories and indexed with no stat.
  const gitlinks: Uint8Array[] = [];
  for (let i = 0; i < plan.count; i++) {
    if (plan.mode(i) !== MODE_GITLINK) continue;
    await writer.directory(plan.path(i));
    gitlinks.push(encodeIndexEntry(plan.path(i), MODE_GITLINK, plan.oid(i), null));
  }
  const gitlinkShare = concat(gitlinks);
  shares.push({ name: 'index-gitlinks', bytes: gitlinkShare.byteLength });
  await writer.file(STAGE_DIR + '/index-gitlinks', 0o644, gitlinkShare);
  const cacheTreeBytes = cacheTree.byteLength;
  await writer.file(STAGE_DIR + '/cache-tree', 0o644, cacheTree);

  const branch = fullRef.startsWith('refs/heads/') ? shortName(fullRef) : null;
  await writer.file('.git/config', 0o644, encoder.encode(cloneConfig(context.url, fullRef, request.filter)));
  await writer.file('.git/HEAD', 0o644, encoder.encode(branch === null ? commit + '\n' : 'ref: ' + fullRef + '\n'));
  if (branch !== null) {
    await writer.file('.git/refs/heads/' + branch, 0o644, encoder.encode(commit + '\n'));
    await writer.file('.git/refs/remotes/origin/' + branch, 0o644, encoder.encode(commit + '\n'));
    await writer.file('.git/refs/remotes/origin/HEAD', 0o644, encoder.encode('ref: refs/remotes/origin/' + branch + '\n'));
  } else {
    await writer.file('.git/' + fullRef, 0o644, encoder.encode(head + '\n'));
  }
  if (response.shallows.length > 0) {
    await writer.file('.git/shallow', 0o644, encoder.encode(response.shallows.sort().join('\n') + '\n'));
  }
  await writer.flush();
  return {
    commit,
    tree,
    headRef: branch === null ? null : fullRef,
    capabilities: [...capabilities],
    batches: batchPlans,
    planEntries: plan.count,
    planBytes: plan.byteLength,
    shares,
    cacheTreeBytes,
    partial,
    packs,
  };
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0;
  for (const part of parts) size += part.byteLength;
  const out = new Uint8Array(size);
  size = 0;
  for (const part of parts) {
    out.set(part, size);
    size += part.byteLength;
  }
  return out;
}

/** One batch: its blobs fetched by id, written at their paths as they resolve. */
export async function cloneBatch(
  context: CloneContext,
  request: { jobId: string; index: number; batchBytes: number; capabilities: readonly string[]; partial?: boolean },
): Promise<CloneBatchResult> {
  const batchPath = join(context.dir, STAGE_DIR + '/batch-' + request.index);
  const blobs = decodeBatch(await readRange(context.supervisor, batchPath, 0, request.batchBytes));
  const receipts = new Map<string, IndexStat>();
  const writer = context.writer((published) => {
    for (const receipt of published) receipts.set(stripSlash(receipt.path), receipt);
  });
  writer.setPin(context.marker.path, context.marker.text, true);

  const response = await requestPack(
    { url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress },
    new Set(request.capabilities),
    { wants: [...blobs.keys()] },
  );
  if (response.pack === null) throw new PackFormatError('the server sent no pack for batch ' + request.index);
  let resolved = 0;
  let files = 0;
  const written: { path: string; mode: number; oid: Uint8Array }[] = [];
  const { summary } = await storePack(context, writer, response.pack, 'tmp_pack_' + request.jobId + '_' + request.index, {
    cacheBytes: BATCH_CACHE_BYTES,
    promisor: request.partial ? [...blobs.keys()].map((oid) => oid + ' ' + oid + '\n').join('') : undefined,
    async onObject(object) {
      if (object.type !== 'blob') return;
      const paths = blobs.get(oidToHex(object.oid));
      if (paths === undefined) return;
      resolved++;
      // The writer takes what it is given, and the base cache keeps
      // `object.data`: each path gets its own copy.
      for (const { mode, path } of paths) {
        if (mode === MODE_SYMLINK) await writer.symlink(path, decoder.decode(object.data));
        else await writer.file(path, mode, object.data.slice());
        written.push({ path, mode, oid: object.oid });
        files++;
      }
    },
  });
  if (resolved !== blobs.size) {
    throw new PackFormatError('batch ' + request.index + ' received ' + resolved + ' of its ' + blobs.size + ' blobs');
  }
  await writer.flush();

  const entries = written.map(({ path, mode, oid }) => {
    const stat = receipts.get(stripSlash(join(context.dir, path)));
    if (stat === undefined) throw new PackFormatError('no receipt for ' + path);
    return encodeIndexEntry(path, mode, oid, stat);
  });
  const share = concat(entries);
  const indexBytes = share.byteLength;
  await writer.file(STAGE_DIR + '/index-' + request.index, 0o644, share);
  await writer.flush();
  return { index: request.index, blobs: resolved, files, indexBytes, pack: summary };
}

/** The index, from the batches' shares; then the staging directory goes. */
export async function cloneFinish(
  context: CloneContext,
  request: { shares: { name: string; bytes: number }[]; full?: boolean; cacheTreeBytes?: number },
): Promise<{ indexEntries: number; indexBytes: number }> {
  const entries: Uint8Array[] = [];
  for (const share of request.shares) {
    if (share.bytes === 0) continue;
    entries.push(...splitIndexEntries(await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/' + share.name), 0, share.bytes)));
  }
  const extensions = request.cacheTreeBytes
    ? [{ signature: 'TREE', data: await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/cache-tree'), 0, request.cacheTreeBytes) }]
    : [];
  const index = encodeIndex(entries, extensions);
  const indexBytes = index.byteLength;
  const writer = context.writer();
  writer.setPin(context.marker.path, context.marker.text, true);
  await writer.file('.git/index', 0o644, index);
  // With its history fetched (history.ts) the clone is no longer shallow.
  if (request.full === true) await writer.remove('.git/shallow');
  // The staged files one record each: a write group holds a bounded number
  // of rows, and one recursive delete of a full clone's staging (vscode:
  // ~200 files) passes it ("logicalRows limit: 326 > 256").
  for (const name of await context.supervisor.readdir(join(context.dir, STAGE_DIR))) {
    await writer.remove(STAGE_DIR + '/' + name);
  }
  await writer.remove(STAGE_DIR, true);
  await writer.flush();
  return { indexEntries: entries.length, indexBytes };
}

export { oidFromHex };

export interface FetchObjectsResult {
  /** Ids the new pack holds. */
  fetched: number;
  pack: PackSummary | null;
}

/**
 * A promisor remote's missing objects, fetched by id in one request, as
 * git's lazy fetch does (promisor-remote.c fetch_objects: --filter=blob:none,
 * so a tree brings its subtrees but no blobs, while a wanted blob is always
 * sent). The pack is stored with its idx and a .promisor naming the ids.
 */
export async function fetchObjects(
  context: CloneContext,
  request: { oids: readonly string[]; jobId: string },
): Promise<FetchObjectsResult> {
  const transport = { url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress };
  const advertisement = await discover(transport);
  if (!advertisement.capabilities.has('allow-reachable-sha1-in-want') && !advertisement.capabilities.has('allow-any-sha1-in-want')) {
    throw new Error('fatal: the promisor remote does not take wants by object id');
  }
  const wanted = [...new Set(request.oids)];
  const response = await requestPack(transport, advertisement.capabilities, { wants: wanted, filter: 'blob:none' });
  if (response.pack === null) return { fetched: 0, pack: null };
  const writer = context.writer();
  const { summary } = await storePack(context, writer, response.pack, 'tmp_pack_' + request.jobId, {
    promisor: wanted.map((oid) => oid + ' ' + oid + '\n').join(''),
  });
  await writer.flush();
  return { fetched: summary.objects, pack: summary };
}
