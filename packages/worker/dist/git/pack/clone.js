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
import { decodeBatch, encodeBatch, CheckoutPlan, MODE_GITLINK, MODE_SYMLINK } from './plan.js';
import { encodeIdxV2 } from './idx.js';
import { encodeIndex, encodeIndexEntry, splitIndexEntries } from './index-file.js';
import { oidFromHex, oidToHex, PackFormatError } from './format.js';
import { PackStreamProcessor } from './processor.js';
import { discover, requestPack } from './upload-pack.js';
const STAGE_DIR = '.git/nimbus-clone';
const PACK_DIR = '.git/objects/pack';
/** Blobs per batch, and at most this many batches. */
const BLOBS_PER_BATCH = 2_500;
const MAX_BATCHES = 16;
/** A batch facet's delta-base cache: blob batches carry few deltas. */
const BATCH_CACHE_BYTES = 4 * 1024 * 1024;
/** Trees a prepare holds to plan from; a shallow tree set is a few MB. */
const PLAN_TREE_BYTES = 48 * 1024 * 1024;
const READ_PIECE_BYTES = 4 * 1024 * 1024;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
/** A pack stored as it arrives, by ranged writes the clone's lease covers. */
class SupervisorPackStore {
    supervisor;
    path;
    size = 0;
    constructor(supervisor, path) {
        this.supervisor = supervisor;
        this.path = path;
    }
    async append(bytes) {
        const at = this.size;
        this.size += bytes.byteLength;
        await this.supervisor.fsWriteRange(this.path, at, bytes);
    }
    async writeAt(offset, bytes) {
        await this.supervisor.fsWriteRange(this.path, offset, bytes);
    }
    async truncate(size) {
        this.size = size;
        await this.supervisor.fsTruncate(this.path, size);
    }
    async read(offset, length) {
        return await readRange(this.supervisor, this.path, offset, length);
    }
}
async function readRange(supervisor, path, offset, length) {
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
function join(dir, path) {
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
/** The config `git clone --depth N` writes. */
function cloneConfig(url, fullRef) {
    const branch = fullRef.startsWith('refs/heads/') ? shortName(fullRef) : null;
    let config = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n' +
        '[remote "origin"]\n\turl = ' + url + '\n';
    config += branch === null
        ? '\tfetch = +' + fullRef + ':' + fullRef + '\n'
        : '\tfetch = +refs/heads/' + branch + ':refs/remotes/origin/' + branch + '\n' +
            '[branch "' + branch + '"]\n\tremote = origin\n\tmerge = refs/heads/' + branch + '\n';
    return config;
}
/** Store a pack stream: process it, name the pack by its id, write its idx last (as git does). */
async function storePack(context, writer, stream, tmpName, options) {
    const store = new SupervisorPackStore(context.supervisor, join(context.dir, PACK_DIR + '/' + tmpName));
    const result = await new PackStreamProcessor({ store, cacheBytes: options.cacheBytes, onObject: options.onObject }).run(stream);
    if (result.checkpoint !== null || result.entries === null) {
        // A batch is sized to decode within one invocation's budget.
        throw new PackFormatError('pack ' + tmpName + ' ran past its decoding budget after ' + result.checkpoint?.decoded + ' entries');
    }
    const packSha = oidToHex(result.packSha);
    await context.supervisor.rename(store.path, join(context.dir, PACK_DIR + '/pack-' + packSha + '.pack'));
    const pieces = [];
    const entries = result.entries;
    for await (const piece of encodeIdxV2(result.objects, result.packSha, async function* () { yield entries; }))
        pieces.push(piece);
    let size = 0;
    for (const piece of pieces)
        size += piece.byteLength;
    const idx = new Uint8Array(size);
    size = 0;
    for (const piece of pieces) {
        idx.set(piece, size);
        size += piece.byteLength;
    }
    await writer.file(PACK_DIR + '/pack-' + packSha + '.idx', 0o644, idx);
    return { result, summary: { packSha, packBytes: result.packBytes, objects: result.objects, work: result.work } };
}
/**
 * The clone's metadata, its commit and trees, and its plan; or why the
 * server cannot serve the fast path.
 */
export async function cloneFast(context, request) {
    const transport = { url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress };
    const advertisement = await discover(transport);
    const capabilities = advertisement.capabilities;
    if (!capabilities.has('filter'))
        return { unsupported: 'the server does not offer filter' };
    if (!capabilities.has('allow-reachable-sha1-in-want') && !capabilities.has('allow-any-sha1-in-want')) {
        return { unsupported: 'the server does not take wants by object id' };
    }
    if (advertisement.refs.size === 0)
        return { unsupported: 'the remote is empty' };
    const { fullRef, commit, tagObject } = resolveRef(advertisement, request.ref);
    const writer = context.writer();
    writer.setPin(context.marker.path, context.marker.text, true);
    for (const dir of ['.git/hooks', '.git/info', '.git/objects/info', PACK_DIR, '.git/refs/heads', '.git/refs/tags', STAGE_DIR]) {
        await writer.directory(dir);
    }
    await writer.flush();
    const response = await requestPack(transport, capabilities, {
        wants: tagObject === null ? [commit] : [tagObject],
        depth: request.depth,
        filter: 'blob:none',
    });
    if (response.pack === null)
        throw new PackFormatError('the server sent no pack for the commit');
    const trees = new Map();
    let treeBytes = 0;
    let commitObject = null;
    const { summary } = await storePack(context, writer, response.pack, 'tmp_pack_' + request.jobId + '_trees', {
        onObject(object) {
            const hex = oidToHex(object.oid);
            if (object.type === 'tree') {
                treeBytes += object.data.byteLength;
                if (treeBytes > PLAN_TREE_BYTES)
                    throw new PackFormatError('the commit\'s trees pass ' + PLAN_TREE_BYTES + ' bytes');
                trees.set(hex, object.data);
            }
            else if (object.type === 'commit' && hex === commit) {
                commitObject = object.data;
            }
        },
    });
    if (commitObject === null)
        throw new PackFormatError('the pack lacks commit ' + commit);
    const treeLine = /^tree ([0-9a-f]{40})\n/.exec(decoder.decode(commitObject.subarray(0, 46)));
    if (!treeLine)
        throw new PackFormatError('commit ' + commit + ' names no tree');
    const tree = treeLine[1];
    const root = trees.get(tree);
    if (root === undefined)
        throw new PackFormatError('the pack lacks tree ' + tree);
    const plan = CheckoutPlan.fromTrees(root, (data, at) => {
        const hex = oidToHex(data, at);
        const found = trees.get(hex);
        if (found === undefined)
            throw new PackFormatError('the pack lacks tree ' + hex);
        return found;
    });
    trees.clear();
    const batches = plan.batches(Math.min(MAX_BATCHES, Math.ceil(plan.count / (request.blobsPerBatch ?? BLOBS_PER_BATCH))));
    const batchPlans = [];
    for (const batch of batches) {
        const encoded = encodeBatch(plan, batch);
        await writer.file(STAGE_DIR + '/batch-' + batch.index, 0o644, encoded);
        batchPlans.push({
            index: batch.index,
            blobs: batch.blobs.length,
            paths: batch.blobs.reduce((n, blob) => n + blob.entries.length, 0),
            bytes: encoded.byteLength,
        });
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
    await writer.file(STAGE_DIR + '/index-gitlinks', 0o644, gitlinkShare);
    const branch = fullRef.startsWith('refs/heads/') ? shortName(fullRef) : null;
    await writer.file('.git/config', 0o644, encoder.encode(cloneConfig(context.url, fullRef)));
    await writer.file('.git/HEAD', 0o644, encoder.encode(branch === null ? commit + '\n' : 'ref: ' + fullRef + '\n'));
    if (branch !== null) {
        await writer.file('.git/refs/heads/' + branch, 0o644, encoder.encode(commit + '\n'));
        await writer.file('.git/refs/remotes/origin/' + branch, 0o644, encoder.encode(commit + '\n'));
        await writer.file('.git/refs/remotes/origin/HEAD', 0o644, encoder.encode('ref: refs/remotes/origin/' + branch + '\n'));
    }
    else {
        await writer.file('.git/' + fullRef, 0o644, encoder.encode((tagObject ?? commit) + '\n'));
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
        gitlinkIndexBytes: gitlinkShare.byteLength,
        pack: summary,
    };
}
function concat(parts) {
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
    const response = await requestPack({ url: context.url, auth: context.auth, fetch: context.fetch, onProgress: context.onProgress }, new Set(request.capabilities), { wants: [...blobs.keys()] });
    if (response.pack === null)
        throw new PackFormatError('the server sent no pack for batch ' + request.index);
    let resolved = 0;
    let files = 0;
    const written = [];
    const { summary } = await storePack(context, writer, response.pack, 'tmp_pack_' + request.jobId + '_' + request.index, {
        cacheBytes: BATCH_CACHE_BYTES,
        async onObject(object) {
            if (object.type !== 'blob')
                return;
            const paths = blobs.get(oidToHex(object.oid));
            if (paths === undefined)
                return;
            resolved++;
            // The writer takes what it is given, and the base cache keeps
            // `object.data`: each path gets its own copy.
            for (const { mode, path } of paths) {
                if (mode === MODE_SYMLINK)
                    await writer.symlink(path, decoder.decode(object.data));
                else
                    await writer.file(path, mode, object.data.slice());
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
        if (stat === undefined)
            throw new PackFormatError('no receipt for ' + path);
        return encodeIndexEntry(path, mode, oid, stat);
    });
    const share = concat(entries);
    await writer.file(STAGE_DIR + '/index-' + request.index, 0o644, share);
    await writer.flush();
    return { index: request.index, blobs: resolved, files, indexBytes: share.byteLength, pack: summary };
}
/** The index, from the batches' shares; then the staging directory goes. */
export async function cloneFinish(context, request) {
    const entries = [];
    for (const share of request.shares) {
        if (share.bytes === 0)
            continue;
        entries.push(...splitIndexEntries(await readRange(context.supervisor, join(context.dir, STAGE_DIR + '/' + share.name), 0, share.bytes)));
    }
    const index = encodeIndex(entries);
    const writer = context.writer();
    writer.setPin(context.marker.path, context.marker.text, true);
    await writer.file('.git/index', 0o644, index);
    await writer.remove(STAGE_DIR, true);
    await writer.flush();
    return { indexEntries: entries.length, indexBytes: index.byteLength };
}
export { oidFromHex };
