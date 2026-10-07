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
import { ENTRY_BYTES, entryOffset } from './idx.js';
import { installPack, RangedPackFile, readRange, resumeInstall } from './install.js';
import { ByteLru } from './byte-lru.js';
import { COMMIT_GRAPHS_DIR, COMMIT_GRAPH_CHAIN, cloneGraph, graphName } from './commit-graph.js';
import { MissingBaseError, PackObjectResolver, runAsync } from './reader.js';
import { encodeIndexEntry, encodeIndexFile, splitIndexEntries } from '../worktree/dircache.js';
import { encodeNode } from '../worktree/cachetree.js';
import { oidFromHex, oidToHex, PACK_TRAILER_BYTES, PackFormatError } from './format.js';
import { PackStreamProcessor } from './processor.js';
import { discover, requestPack } from './upload-pack.js';
import { PackObjectStore } from './store.js';
/**
 * Which of the remote's tags a clone fetched, seen as its packs are
 * decoded: the commit and tag objects a tag names or peels to. git clone
 * writes a tag whose object it has; finish writes these, reading nothing.
 */
export class TagWatch {
    interest;
    found = new Set();
    constructor(interest) {
        this.interest = new Set(interest);
    }
    static of(tags) {
        return new TagWatch(tags.flatMap((tag) => [tag.oid, tag.peeled]));
    }
    see(type, oid) {
        if (this.interest.size === 0 || (type !== 'commit' && type !== 'tag'))
            return;
        const hex = oidToHex(oid);
        if (this.interest.has(hex))
            this.found.add(hex);
    }
}
/** The tags whose objects the clone holds: those finish writes. */
export function tagsHeld(tags, found) {
    return tags.filter((tag) => found.has(tag.peeled) && (tag.oid === tag.peeled || found.has(tag.oid)));
}
/** The tags the remote advertises (refs/tags/*, peeled through "<name>^{}"). */
function advertisedTags(advertisement) {
    const tags = [];
    for (const [name, oid] of advertisement.refs) {
        if (!name.startsWith('refs/tags/') || name.endsWith('^{}'))
            continue;
        tags.push({ name, oid, peeled: advertisement.refs.get(name + '^{}') ?? oid });
    }
    return tags;
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
/** A streamed clone's one pack is resolved with this cache, and this many stored bytes kept readable. */
const STREAM_CACHE_BYTES = 8 * 1024 * 1024;
const STREAM_RECENT_BYTES = 24 * 1024 * 1024;
/** Blobs held while a filtered pack's trees are still arriving. */
const HELD_BLOB_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
export { readRange };
/** A resumed step run again after its answer was lost: its recorded outcome, its pack's naming finished; or null. */
export async function settledBefore(context, tmpName, recordName) {
    return await resumeInstall(packFiles(context), join(context.dir, PACK_DIR), tmpName, join(context.dir, STAGE_DIR + '/' + recordName));
}
/**
 * The clone's ranged file calls (its lease covers them); whole files and
 * removals are waves of the step's writer (`writer`), or of one made for
 * them where the step has none.
 */
function packFiles(context, writer) {
    const supervisor = context.supervisor;
    const relative = (path) => path.slice(context.dir.length + 1);
    let own = null;
    const waves = () => writer ?? (own ??= context.writer());
    return {
        fsWriteRange: (path, offset, bytes) => supervisor.fsWriteRange(path, offset, bytes),
        fsTruncate: (path, size) => supervisor.fsTruncate(path, size),
        fsReadRange: (path, offset, length) => supervisor.fsReadRange(path, offset, length),
        rename: (from, to) => supervisor.rename(from, to),
        readdir: (path) => supervisor.readdir(path),
        async remove(path) {
            await waves().remove(relative(path));
            await waves().flush();
        },
        async writeFiles(files, durable) {
            for (const file of files)
                await waves().file(relative(file.path), 0o644, file.bytes);
            // Otherwise the step's last flush carries them, before it answers.
            if (durable || writer === undefined)
                await waves().flush();
        },
    };
}
export function join(dir, path) {
    return dir + '/' + path;
}
function stripSlash(path) {
    return path.startsWith('/') ? path.slice(1) : path;
}
/** The ref a clone checks out, and the objects that name it. */
function resolveRef(advertisement, ref) {
    const candidates = ref === undefined
        ? [advertisement.symrefs.get('HEAD') ?? 'HEAD']
        : ref.startsWith('refs/') ? [ref] : ['refs/heads/' + ref, 'refs/tags/' + ref];
    for (const fullRef of candidates) {
        const oid = advertisement.refs.get(fullRef);
        if (oid === undefined)
            continue;
        const peeled = advertisement.refs.get(fullRef + '^{}');
        return { fullRef, commit: peeled ?? oid, tagObject: peeled === undefined ? null : oid };
    }
    throw new Error('fatal: Remote branch ' + (ref ?? 'HEAD') + ' not found in upstream origin');
}
function shortName(fullRef) {
    return fullRef.replace(/^refs\/(heads|tags)\//, '');
}
/**
 * The config `git clone --depth N [--filter=<spec>]` writes. Of an empty
 * remote git's single-branch clone writes no fetch refspec (`empty`).
 */
function cloneConfig(url, fullRef, filter, empty = false) {
    const branch = fullRef.startsWith('refs/heads/') ? shortName(fullRef) : null;
    // A partial clone's repository is format 1 (extensions); git sets it so.
    let config = '[core]\n\trepositoryformatversion = ' + (filter === undefined ? 0 : 1) +
        '\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n' +
        '[remote "origin"]\n\turl = ' + url + '\n';
    if (!empty) {
        config += branch === null
            ? '\tfetch = +' + fullRef + ':' + fullRef + '\n'
            : '\tfetch = +refs/heads/' + branch + ':refs/remotes/origin/' + branch + '\n';
    }
    if (filter !== undefined)
        config += '\tpromisor = true\n\tpartialclonefilter = ' + filter + '\n';
    if (branch !== null)
        config += '[branch "' + branch + '"]\n\tremote = origin\n\tmerge = refs/heads/' + branch + '\n';
    return config;
}
/**
 * Store a pack stream: process it, name the pack by its id, write its idx
 * last (as git does). `promisor` is the pack's .promisor file, written
 * before the idx when the clone is partial: what git writes, the refs or
 * ids the fetch asked for, one "<id> <name>" line each.
 */
async function storePack(context, writer, stream, tmpName, options) {
    // A clone's batches cannot resume: their reads are not capped.
    const stored = await storePackResumable(context, writer, stream, tmpName, { maxStoreReads: Number.POSITIVE_INFINITY, ...options });
    if ('pending' in stored) {
        // A clone's batches are sized to decode within one invocation's budget.
        throw new PackFormatError('pack ' + tmpName + ' ran past its decoding budget after ' + stored.pending.decoded + ' entries');
    }
    return stored;
}
/** storePack, or where its decoding stopped when the budget ran out first (see resumePack). */
export async function storePackResumable(context, writer, stream, tmpName, options) {
    const store = new RangedPackFile(packFiles(context), join(context.dir, PACK_DIR + '/' + tmpName));
    const result = await new PackStreamProcessor({
        store,
        cacheBytes: options.cacheBytes,
        recentBytes: options.recentBytes,
        budgetUnits: options.budgetUnits,
        maxStoreReads: options.maxStoreReads ?? MAX_STORE_READS,
        onObject: options.onObject,
    }).run(stream);
    return await settlePack(context, writer, tmpName, result, options.promisor, options.record);
}
/** Continue decoding a pending pack from its stored bytes; it may stop at the budget again. */
export async function resumePack(context, writer, pending, options) {
    const store = new RangedPackFile(packFiles(context), join(context.dir, PACK_DIR + '/' + pending.tmpName));
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
    return await settlePack(context, writer, pending.tmpName, result, pending.promisor, options.record);
}
/** Name a fully decoded pack and write its idx (and .promisor); or checkpoint it. */
async function settlePack(context, writer, tmpName, result, promisor, record) {
    if (result.checkpoint !== null || result.entries === null) {
        const checkpoint = result.checkpoint;
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
    // What the step writes besides is durable before its pack is named.
    const extra = record === undefined ? undefined : await record.publish();
    await writer.flush();
    const summary = await installPack(packFiles(context, writer), {
        dir: join(context.dir, PACK_DIR),
        tmpName,
        result,
        promisor,
        record: record === undefined ? undefined : { path: join(context.dir, STAGE_DIR + '/' + record.name), extra },
    });
    if (summary === null)
        throw new PackFormatError('pack ' + tmpName + ' holds no objects');
    return { result, summary };
}
/** The tree id a commit object names. */
export function commitTree(commit, oid) {
    const line = /^tree ([0-9a-f]{40})\n/.exec(decoder.decode(commit.subarray(0, 46)));
    if (!line)
        throw new PackFormatError('commit ' + oid + ' names no tree');
    return line[1];
}
/** The cache tree of `root`, as written: each tree's id and how many index entries it covers. */
function cacheTreeOf(name, root, trees) {
    const data = trees.get(root);
    if (data === undefined)
        throw new PackFormatError('the pack lacks tree ' + root);
    let count = 0;
    const subtrees = [];
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
function treesComplete(trees, root) {
    const pending = [root];
    while (pending.length > 0) {
        const data = trees.get(pending.pop());
        if (data === undefined)
            return false;
        for (const entry of parseTree(data))
            if (entry.mode === MODE_TREE)
                pending.push(oidToHex(data, entry.oidAt));
    }
    return true;
}
function takesWantsById(advertisement) {
    return advertisement.capabilities.has('allow-reachable-sha1-in-want') || advertisement.capabilities.has('allow-any-sha1-in-want');
}
/**
 * The remote's refs and capabilities, before the clone writes anything: a
 * clone the server cannot serve is refused here. git would ignore a filter
 * the server does not support and clone everything; and a partial clone
 * whose server cannot send its missing objects by id is no clone.
 */
export async function cloneDiscover(context, request) {
    const advertisement = await discover({ url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress });
    if (request.filter !== undefined && advertisement.refs.size > 0) {
        if (!advertisement.capabilities.has('filter'))
            throw new Error('fatal: the server does not support --filter: clone without it');
        if (!takesWantsById(advertisement)) {
            throw new Error('fatal: the server does not send objects by id, which a partial clone fetches on demand: clone without --filter');
        }
    }
    return advertisement;
}
/**
 * The clone's metadata, its commit and trees, and its plan; or, from a
 * server without filter or wants by id, its one pack (cloneStream).
 *
 * Without --filter prepare asks for blob:none and every blob comes in the
 * batches. With one, prepare asks for the user's filter: a blob:limit pack
 * also carries the small blobs, written at their paths as they arrive (a
 * pack's trees precede its blobs), and a tree:<depth> pack lacks deep trees,
 * which one more blob:none request for the root tree brings, as git's lazy
 * fetch would. Every pack of a partial clone is a promisor pack.
 */
export async function cloneFast(context, request, advertisement) {
    const transport = { url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress };
    const capabilities = advertisement.capabilities;
    // An empty remote's clone is partial as git's is: its config names the promisor.
    if (advertisement.refs.size === 0)
        return await cloneEmpty(context, advertisement, request.filter);
    if (!capabilities.has('filter') || !takesWantsById(advertisement))
        return await cloneStream(context, request, advertisement, transport);
    const { fullRef, commit, tagObject } = resolveRef(advertisement, request.ref);
    const partial = request.filter !== undefined;
    const writer = context.writer();
    writer.setPin(context.marker.path, context.marker.text, true);
    for (const dir of CLONE_DIRECTORIES)
        await writer.directory(dir);
    await writer.flush();
    const response = await requestPack(transport, capabilities, {
        wants: tagObject === null ? [commit] : [tagObject],
        depth: request.depth,
        filter: request.filter ?? 'blob:none',
    });
    if (response.pack === null)
        throw new PackFormatError('the server sent no pack for the commit');
    const trees = new Map();
    let treeBytes = 0;
    let commitObject = null;
    let plan = null;
    let planBlobs = null;
    // Blobs a blob:limit pack carries, written as they arrive with their index entries.
    const arrived = new Set();
    const inline = [];
    const receipts = new Map();
    let blobWriter = null;
    const keepTree = (hex, data) => {
        treeBytes += data.byteLength;
        if (treeBytes > PLAN_TREE_BYTES)
            throw new PackFormatError('the commit\'s trees pass ' + PLAN_TREE_BYTES + ' bytes');
        trees.set(hex, data);
    };
    const planFrom = () => {
        if (commitObject === null)
            throw new PackFormatError('the pack lacks commit ' + commit);
        const root = trees.get(commitTree(commitObject, commit));
        if (root === undefined)
            throw new PackFormatError('the pack lacks the commit\'s tree');
        return CheckoutPlan.fromTrees(root, (data, at) => {
            const found = trees.get(oidToHex(data, at));
            if (found === undefined)
                throw new PackFormatError('the pack lacks tree ' + oidToHex(data, at));
            return found;
        });
    };
    const head = tagObject ?? commit;
    const promisorRefs = head + ' HEAD\n' + head + ' ' + fullRef + '\n';
    // The tag cloned is in packed-refs; the others the clone holds are followed.
    const tags = advertisedTags(advertisement).filter((tag) => tag.name !== fullRef);
    const watch = TagWatch.of(tags);
    // A blob that arrives before the checkout's trees are all in (git's write
    // order puts trees first, but a filtered pack need not) is held, to a
    // budget, and past it left in the stored pack to be read back by offset.
    const held = new Map();
    let heldBytes = 0;
    const deferred = new Set();
    let plannable = null;
    const emit = async (hex, oid, data) => {
        const entries = planBlobs.get(hex);
        if (entries === undefined || arrived.has(hex))
            return;
        arrived.add(hex);
        if (blobWriter === null) {
            blobWriter = context.writer((published) => {
                for (const receipt of published)
                    receipts.set(stripSlash(receipt.path), receipt);
            });
            blobWriter.setPin(context.marker.path, context.marker.text, true);
        }
        for (const entry of entries) {
            const path = plan.path(entry);
            const mode = plan.mode(entry);
            if (mode === MODE_SYMLINK)
                await blobWriter.symlink(path, decoder.decode(data));
            else
                await blobWriter.file(path, mode, data.slice());
            inline.push({ path, mode, oid });
        }
    };
    const { result: prepareResult, summary } = await storePack(context, writer, response.pack, 'tmp_pack_' + request.jobId + '_trees', {
        promisor: partial ? promisorRefs : undefined,
        async onObject(object) {
            const hex = oidToHex(object.oid);
            watch.see(object.type, object.oid);
            if (object.type === 'tree')
                keepTree(hex, object.data);
            else if (object.type === 'commit' && hex === commit)
                commitObject = object.data;
            else if (object.type === 'blob') {
                plannable ??= commitObject !== null && treesComplete(trees, commitTree(commitObject, commit));
                if (plannable && plan === null) {
                    plan = planFrom();
                    planBlobs = plan.blobPaths();
                }
                if (plan !== null)
                    await emit(hex, object.oid, object.data);
                else if (heldBytes + object.data.byteLength <= HELD_BLOB_BYTES) {
                    held.set(hex, object.data.slice());
                    heldBytes += object.data.byteLength;
                }
                else
                    deferred.add(hex);
            }
        },
    });
    if (commitObject === null)
        throw new PackFormatError('the pack lacks commit ' + commit);
    const tree = commitTree(commitObject, commit);
    const packs = [summary];
    if (plan === null && !treesComplete(trees, tree)) {
        // tree:<depth> stopped short of the checkout's trees: fetch them all, no blobs.
        const more = await requestPack(transport, capabilities, { wants: [tree], filter: 'blob:none' });
        if (more.pack === null)
            throw new PackFormatError('the server sent no pack for tree ' + tree);
        const { summary: treesPack } = await storePack(context, writer, more.pack, 'tmp_pack_' + request.jobId + '_tree', {
            promisor: partial ? tree + ' ' + tree + '\n' : undefined,
            onObject(object) {
                if (object.type === 'tree')
                    keepTree(oidToHex(object.oid), object.data);
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
    for (const [hex, data] of held)
        await emit(hex, oidFromHex(hex), data);
    held.clear();
    if (deferred.size > 0) {
        const resolver = new PackObjectResolver({
            file: join(context.dir, PACK_DIR + '/pack-' + summary.packSha + '.pack'),
            dataEnd: summary.packBytes - PACK_TRAILER_BYTES,
            cache: new ByteLru(BATCH_CACHE_BYTES),
            refBase: (oid) => { throw new MissingBaseError(oid); },
        });
        const records = prepareResult.entries;
        for (let i = 0; i * ENTRY_BYTES < records.byteLength; i++) {
            const hex = oidToHex(records, i * ENTRY_BYTES);
            if (!deferred.has(hex))
                continue;
            const object = await runAsync(resolver.objectAt(entryOffset(records, i)), (range) => readRange(context.supervisor, range.file, range.offset, range.length));
            await emit(hex, oidFromHex(hex), object.data);
        }
    }
    const shares = [];
    if (blobWriter !== null) {
        await blobWriter.flush();
        const share = concat(inline.map(({ path, mode, oid }) => {
            const stat = receipts.get(stripSlash(join(context.dir, path)));
            if (stat === undefined)
                throw new PackFormatError('no receipt for ' + path);
            return encodeIndexEntry(path, mode, oid, stat);
        }));
        shares.push({ name: 'index-prepare', bytes: share.byteLength });
        await writer.file(STAGE_DIR + '/index-prepare', 0o644, share);
    }
    const staged = await stagePlan(writer, plan, cacheTree, arrived, request.blobsPerBatch);
    shares.push(...staged.shares);
    await writeCloneMetadata(writer, context.url, { fullRef, commit, tagObject, shallows: response.shallows, filter: request.filter });
    await writer.flush();
    return {
        commit,
        tree,
        headRef: fullRef.startsWith('refs/heads/') ? fullRef : null,
        capabilities: [...capabilities],
        batches: staged.batches,
        planEntries: plan.count,
        planBytes: plan.byteLength,
        shares,
        cacheTreeBytes: staged.cacheTreeBytes,
        partial,
        packs,
        tags,
        tagsFound: [...watch.found],
    };
}
/**
 * The checkout's staged files: a batch file per run of blobs not in
 * `present` (plan.ts encodeBatch), the gitlinks' index entries (each also an
 * empty directory), and the TREE extension's bytes.
 */
async function stagePlan(writer, plan, cacheTree, present, blobsPerBatch) {
    const batches = plan.batches(Math.min(MAX_BATCHES, Math.ceil(plan.count / (blobsPerBatch ?? BLOBS_PER_BATCH))), present);
    const batchPlans = [];
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
    const gitlinks = [];
    for (let i = 0; i < plan.count; i++) {
        if (plan.mode(i) !== MODE_GITLINK)
            continue;
        await writer.directory(plan.path(i));
        gitlinks.push(encodeIndexEntry(plan.path(i), MODE_GITLINK, plan.oid(i), null));
    }
    const gitlinkShare = concat(gitlinks);
    const shares = [{ name: 'index-gitlinks', bytes: gitlinkShare.byteLength }];
    await writer.file(STAGE_DIR + '/index-gitlinks', 0o644, gitlinkShare);
    const cacheTreeBytes = cacheTree.byteLength;
    await writer.file(STAGE_DIR + '/cache-tree', 0o644, cacheTree);
    return { batches: batchPlans, shares, cacheTreeBytes };
}
/**
 * config, HEAD, the branch and its remote-tracking refs (or the tag),
 * shallow: as git clone writes them. git packs the refs it fetched into
 * packed-refs (the remote-tracking branch, or the tag with its peeled id);
 * the local branch and origin/HEAD are loose.
 */
async function writeCloneMetadata(writer, url, clone) {
    const { fullRef, commit } = clone;
    const branch = fullRef.startsWith('refs/heads/') ? shortName(fullRef) : null;
    await writer.file('.git/config', 0o644, encoder.encode(cloneConfig(url, fullRef, clone.filter)));
    await writer.file('.git/HEAD', 0o644, encoder.encode(branch === null ? commit + '\n' : 'ref: ' + fullRef + '\n'));
    const packed = '# pack-refs with: peeled fully-peeled sorted \n';
    if (branch !== null) {
        await writer.file('.git/refs/heads/' + branch, 0o644, encoder.encode(commit + '\n'));
        await writer.file('.git/packed-refs', 0o644, encoder.encode(packed + commit + ' refs/remotes/origin/' + branch + '\n'));
        await writer.file('.git/refs/remotes/origin/HEAD', 0o644, encoder.encode('ref: refs/remotes/origin/' + branch + '\n'));
    }
    else {
        const peeled = clone.tagObject === null ? '' : '^' + commit + '\n';
        await writer.file('.git/packed-refs', 0o644, encoder.encode(packed + (clone.tagObject ?? commit) + ' ' + fullRef + '\n' + peeled));
    }
    if (clone.shallows.length > 0) {
        await writer.file('.git/shallow', 0o644, encoder.encode([...clone.shallows].sort().join('\n') + '\n'));
    }
}
const CLONE_DIRECTORIES = ['.git/hooks', '.git/info', '.git/objects/info', PACK_DIR, '.git/refs/heads', '.git/refs/tags', STAGE_DIR];
/**
 * A clone from a server without `filter` or wants by id: its one pack, as
 * git would fetch it (the commit at `depth`, or all its history), stored and
 * indexed as it arrives; decoding that runs past the budget continues from
 * the stored pack (history.ts historyResume, kind 'snapshot'), and the
 * checkout is then planned from the pack (clonePlanFromStore) and written by
 * batches that read their blobs from it.
 */
async function cloneStream(context, request, advertisement, transport) {
    const { fullRef, commit, tagObject } = resolveRef(advertisement, request.ref);
    const writer = context.writer();
    writer.setPin(context.marker.path, context.marker.text, true);
    for (const dir of CLONE_DIRECTORIES)
        await writer.directory(dir);
    await writer.flush();
    const response = await requestPack(transport, advertisement.capabilities, {
        wants: [tagObject ?? commit],
        depth: request.history ? undefined : request.depth,
    });
    if (response.pack === null)
        throw new PackFormatError('the server sent no pack for the commit');
    // The tag cloned is in packed-refs; the others the clone holds are followed.
    const tags = advertisedTags(advertisement).filter((tag) => tag.name !== fullRef);
    const watch = TagWatch.of(tags);
    const stored = await storePackResumable(context, writer, response.pack, 'tmp_pack_' + request.jobId + '_snapshot', {
        cacheBytes: STREAM_CACHE_BYTES,
        recentBytes: STREAM_RECENT_BYTES,
        budgetUnits: request.budgetUnits,
        onObject: (object) => watch.see(object.type, object.oid),
    });
    await writeCloneMetadata(writer, context.url, { fullRef, commit, tagObject, shallows: response.shallows });
    await writer.flush();
    return {
        stream: {
            commit,
            headRef: fullRef.startsWith('refs/heads/') ? fullRef : null,
            pending: 'pending' in stored ? stored.pending : null,
            pack: 'pending' in stored ? null : stored.summary,
            tags,
            tagsFound: [...watch.found],
        },
    };
}
/** The empty repository git clone makes of an empty remote. */
async function cloneEmpty(context, advertisement, filter) {
    const writer = context.writer();
    writer.setPin(context.marker.path, context.marker.text, true);
    for (const dir of CLONE_DIRECTORIES)
        await writer.directory(dir);
    // Without the remote's HEAD (protocol v0 names no unborn branch) git takes
    // its init default, as Nimbus's git init does.
    const fullRef = advertisement.symrefs.get('HEAD') ?? 'refs/heads/master';
    await writer.file('.git/config', 0o644, encoder.encode(cloneConfig(context.url, fullRef, filter, true)));
    await writer.file('.git/HEAD', 0o644, encoder.encode('ref: ' + fullRef + '\n'));
    await writer.flush();
    return {
        commit: null,
        tree: null,
        headRef: fullRef,
        capabilities: [...advertisement.capabilities],
        batches: [],
        planEntries: 0,
        planBytes: 0,
        shares: [],
        cacheTreeBytes: 0,
        partial: filter !== undefined,
        packs: [],
        tags: [],
        tagsFound: [],
    };
}
/** Every tree under `root`, read from the repository's packs. */
async function readTrees(store, root) {
    const trees = new Map();
    const pending = [root];
    let bytes = 0;
    while (pending.length > 0) {
        const oid = pending.pop();
        if (trees.has(oid))
            continue;
        const object = await store.read(oid);
        if (object === null || object.type !== 'tree')
            throw new PackFormatError('the clone lacks tree ' + oid);
        bytes += object.data.byteLength;
        if (bytes > PLAN_TREE_BYTES)
            throw new PackFormatError('the commit\'s trees pass ' + PLAN_TREE_BYTES + ' bytes');
        trees.set(oid, object.data);
        for (const entry of parseTree(object.data))
            if (entry.mode === MODE_TREE)
                pending.push(oidToHex(object.data, entry.oidAt));
    }
    return trees;
}
function supervisorStore(context) {
    return new PackObjectStore({
        readRange: async (path, offset, length) => (await context.supervisor.fsReadRange(path, offset, length)) ?? new Uint8Array(0),
        readdir: (dir) => context.supervisor.readdir(dir),
    }, join(context.dir, '.git'));
}
/** A streamed clone's checkout plan, from its stored pack: the batches then read their blobs from it. */
export async function clonePlanFromStore(context, request) {
    const store = supervisorStore(context);
    const commitObject = await store.read(request.commit);
    if (commitObject === null || commitObject.type !== 'commit')
        throw new PackFormatError('the clone lacks commit ' + request.commit);
    const tree = commitTree(commitObject.data, request.commit);
    const trees = await readTrees(store, tree);
    const plan = CheckoutPlan.fromTrees(trees.get(tree), (data, at) => trees.get(oidToHex(data, at)));
    const cacheTree = cacheTreeOf('', tree, trees).built.bytes;
    trees.clear();
    const writer = context.writer();
    writer.setPin(context.marker.path, context.marker.text, true);
    const staged = await stagePlan(writer, plan, cacheTree, new Set(), request.blobsPerBatch);
    await writer.flush();
    return {
        commit: request.commit,
        tree,
        headRef: null,
        capabilities: [],
        batches: staged.batches,
        planEntries: plan.count,
        planBytes: plan.byteLength,
        shares: staged.shares,
        cacheTreeBytes: staged.cacheTreeBytes,
        partial: false,
        packs: [],
        tags: [],
        tagsFound: [],
    };
}
export function concat(parts) {
    let size = 0;
    for (const part of parts)
        size += part.byteLength;
    const out = new Uint8Array(size);
    size = 0;
    for (const part of parts) {
        out.set(part, size);
        size += part.byteLength;
    }
    return out;
}
/** One batch: its blobs fetched by id, written at their paths as they resolve. */
export async function cloneBatch(context, request) {
    const batchPath = join(context.dir, STAGE_DIR + '/batch-' + request.index);
    const blobs = decodeBatch(await readRange(context.supervisor, batchPath, 0, request.batchBytes));
    const receipts = new Map();
    const writer = context.writer((published) => {
        for (const receipt of published)
            receipts.set(stripSlash(receipt.path), receipt);
    });
    writer.setPin(context.marker.path, context.marker.text, true);
    let resolved = 0;
    let files = 0;
    const written = [];
    const emit = async (oid, data) => {
        const paths = blobs.get(oidToHex(oid));
        if (paths === undefined)
            return;
        resolved++;
        // The writer takes what it is given, and the base cache keeps `data`:
        // each path gets its own copy.
        for (const { mode, path } of paths) {
            if (mode === MODE_SYMLINK)
                await writer.symlink(path, decoder.decode(data));
            else
                await writer.file(path, mode, data.slice());
            written.push({ path, mode, oid });
            files++;
        }
    };
    let summary = null;
    if (request.local) {
        const store = supervisorStore(context);
        for (const oid of blobs.keys()) {
            const object = await store.read(oid);
            if (object === null || object.type !== 'blob')
                throw new PackFormatError('the clone lacks blob ' + oid);
            await emit(oidFromHex(oid), object.data);
        }
    }
    else {
        const response = await requestPack({ url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress }, new Set(request.capabilities), { wants: [...blobs.keys()] });
        if (response.pack === null)
            throw new PackFormatError('the server sent no pack for batch ' + request.index);
        ({ summary } = await storePack(context, writer, response.pack, 'tmp_pack_' + request.jobId + '_' + request.index, {
            cacheBytes: BATCH_CACHE_BYTES,
            promisor: request.partial ? [...blobs.keys()].map((oid) => oid + ' ' + oid + '\n').join('') : undefined,
            async onObject(object) {
                if (object.type === 'blob')
                    await emit(object.oid, object.data);
            },
        }));
    }
    if (resolved !== blobs.size) {
        throw new PackFormatError('batch ' + request.index + ' received ' + resolved + ' of its ' + blobs.size + ' blobs');
    }
    await writer.flush();
    const entries = written.map(({ path, mode, oid }) => {
        const stat = receipts.get(stripSlash(join(context.dir, path)));
        if (stat === undefined)
            throw new PackFormatError('no receipt for ' + path);
        return encodeIndexEntry(path, mode, oid, stat);
    });
    const share = concat(entries);
    const indexBytes = share.byteLength;
    await writer.file(STAGE_DIR + '/index-' + request.index, 0o644, share);
    await writer.flush();
    return { index: request.index, blobs: resolved, files, indexBytes, pack: summary };
}
/**
 * A full clone's commit records past this many bytes are not made a graph
 * at the clone (about 130 bytes a commit in memory: ~250,000 commits);
 * `git commit-graph write` builds one for a history that large.
 */
const GRAPH_RECORD_BYTES_MAX = 16 * 1024 * 1024;
/** The index, from the batches' shares; a full clone's commit-graph; then the staging directory goes. */
export async function cloneFinish(context, request) {
    const entries = [];
    for (const share of request.shares) {
        if (share.bytes === 0)
            continue;
        entries.push(...splitIndexEntries(await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/' + share.name), 0, share.bytes)));
    }
    // git's racy rule: an entry whose mtime is not before the index's own is
    // re-read by status. The index lands after the second its newest file did.
    let newest = 0;
    for (const entry of entries)
        newest = Math.max(newest, new DataView(entry.buffer, entry.byteOffset + 8, 4).getUint32(0));
    const wait = (newest + 1) * 1000 - Date.now();
    if (wait > 0)
        await new Promise((resolve) => setTimeout(resolve, wait));
    const extensions = request.cacheTreeBytes
        ? [{ signature: 'TREE', bytes: await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/cache-tree'), 0, request.cacheTreeBytes) }]
        : [];
    const index = encodeIndexFile(entries, extensions);
    const indexBytes = index.byteLength;
    const writer = context.writer();
    writer.setPin(context.marker.path, context.marker.text, true);
    await writer.file('.git/index', 0o644, index);
    // With its history fetched (history.ts) the clone is no longer shallow.
    if (request.full === true)
        await writer.remove('.git/shallow');
    // git clone follows tags: those whose objects it fetched (include-tag sent
    // the annotated ones with their commits; tagsHeld), each a loose ref.
    for (const tag of request.tags ?? [])
        await writer.file('.git/' + tag.name, 0o644, encoder.encode(tag.oid + '\n'));
    const tags = request.tags?.length ?? 0;
    const graphed = await writeCloneGraph(context, writer, request.graph ?? null);
    // The staged files one record each: a write group holds a bounded number
    // of rows, and one recursive delete of a full clone's staging (vscode:
    // ~200 files) passes it ("logicalRows limit: 326 > 256").
    for (const name of await context.supervisor.readdir(join(context.dir, STAGE_DIR))) {
        await writer.remove(STAGE_DIR + '/' + name);
    }
    await writer.remove(STAGE_DIR, true);
    await writer.flush();
    return { indexEntries: entries.length, indexBytes, tags, graphCommits: graphed };
}
/**
 * A full clone's commit-graph (commit-graph.ts), as git writes one with
 * --split: a layer named for its hash, and the chain naming it, both 0444.
 * Returns its commits; 0 when there is none to write (a shallow clone, a
 * commit that did not parse, a parent not recorded, records past the bound).
 */
async function writeCloneGraph(context, writer, lists) {
    if (lists === null || lists.length === 0)
        return 0;
    let total = 0;
    for (const list of lists)
        total += list.bytes;
    if (total > GRAPH_RECORD_BYTES_MAX)
        return 0;
    const bytes = [];
    for (const list of lists)
        bytes.push(await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/' + list.name), 0, list.bytes));
    const built = cloneGraph(bytes);
    if (built === null)
        return 0;
    const graph = built.file;
    const name = graphName(graph);
    await writer.directory(COMMIT_GRAPHS_DIR);
    await writer.file(COMMIT_GRAPHS_DIR + '/graph-' + name + '.graph', 0o444, graph);
    await writer.file(COMMIT_GRAPH_CHAIN, 0o444, encoder.encode(name + '\n'));
    return built.commits;
}
export { oidFromHex };
/**
 * A promisor remote's missing objects, fetched by id in one request, as
 * git's lazy fetch does (promisor-remote.c fetch_objects: --filter=blob:none,
 * so a tree brings its subtrees but no blobs, while a wanted blob is always
 * sent). The pack is stored with its idx and a .promisor naming the ids.
 */
export async function fetchObjects(context, request) {
    const transport = { url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress };
    const advertisement = await discover(transport);
    if (!advertisement.capabilities.has('allow-reachable-sha1-in-want') && !advertisement.capabilities.has('allow-any-sha1-in-want')) {
        throw new Error('fatal: the promisor remote does not take wants by object id');
    }
    const wanted = [...new Set(request.oids)];
    const response = await requestPack(transport, advertisement.capabilities, { wants: wanted, filter: 'blob:none' });
    if (response.pack === null)
        return { fetched: 0, pack: null };
    const writer = context.writer();
    const { summary } = await storePack(context, writer, response.pack, 'tmp_pack_' + request.jobId, {
        promisor: wanted.map((oid) => oid + ' ' + oid + '\n').join(''),
    });
    await writer.flush();
    return { fetched: summary.objects, pack: summary };
}
