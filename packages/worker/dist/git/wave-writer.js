/**
 * git/wave-writer.ts — a producer's writes into the session, as W7 waves.
 *
 * Every git write a facet makes (a clone's files, fetch and pull's objects
 * and refs) is a record: a file, a link, a directory, or a removal. The
 * writer buffers records into a wave and publishes the wave through one
 * supervisor.writeBatchStream() call. A wave closes before it would pass
 * W7's owned-path bound (files, removals and the directories above them, up
 * to the root) or its byte budget; a file larger than the budget travels in
 * a wave of its own, and one streamed from a source is never held whole.
 *
 * Pipelining: one wave is in flight while the next one buffers. A wave
 * starts only once its predecessor has published, so a producer waits only
 * when it fills a second wave, and a failed wave is the last this writer
 * sends: the failure names its wave, and every later call rejects with it.
 *
 * Admitting a record costs its own new directories, never a recount of the
 * wave: the owned set grows as records arrive, and a directory chain walk
 * stops at the first directory already owned (whose chain is owned).
 *
 * Several writers may publish into one session at once (a clone's parallel
 * producers); each is its own stream, and the session takes them
 * concurrently.
 */
import { encodeWriteBatchStream, W7_MAX_OWNED_PATH_BYTES, W7_MAX_PATHS_PER_BATCH, } from '@nimbus-sh/platform/w7-frame.js';
import { CHUNK_SIZE } from '@nimbus-sh/platform/limits.js';
import { disposeRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
/** Paths a wave holds back from W7's bound, for its pinned marker and the marker's directories. */
export const WAVE_PATHS = W7_MAX_PATHS_PER_BATCH - 8;
export const WAVE_PATH_BYTES = W7_MAX_OWNED_PATH_BYTES - 4 * 1024;
/** Buffered content bytes that close a wave. */
export const WAVE_BYTES = 4 * 1024 * 1024;
export class WaveFailure extends Error {
    wave;
    constructor(wave, cause) {
        super(`git write wave ${wave} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = 'WaveFailure';
        this.wave = wave;
    }
}
const encoder = new TextEncoder();
function parentOf(path) {
    const slash = path.lastIndexOf('/');
    return slash < 0 ? '' : path.slice(0, slash);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function waveResultError(result) {
    if (!isRecord(result))
        return new Error('writeBatchStream failed: missing writeBatchStream result');
    if (result.ok === true)
        return null;
    const error = result.error;
    const detail = isRecord(error) && typeof error.message === 'string'
        ? error.message
        : 'missing writeBatchStream result';
    return new Error('writeBatchStream failed after group ' + String(result.committedGroupSequence) +
        ' (' + String(result.committedPathCount) + ' committed paths): ' + detail);
}
const RECEIPT_NUMBERS = ['ino', 'mode', 'size', 'mtimeMs', 'ctimeMs', 'uid', 'gid', 'dev'];
/** The session's stat of each published file, as it answered the wave. */
function parseReceipts(result) {
    if (!isRecord(result) || result.receipts === undefined)
        return [];
    if (!Array.isArray(result.receipts))
        throw new Error('writeBatchStream receipts are not a list');
    return result.receipts.map((value) => {
        if (!isRecord(value) || typeof value.path !== 'string') {
            throw new Error('writeBatchStream receipt is invalid');
        }
        const receipt = {
            path: value.path, ino: 0, mode: 0, size: 0, mtimeMs: 0, ctimeMs: 0, uid: 0, gid: 0, dev: 0,
        };
        for (const field of RECEIPT_NUMBERS) {
            const number = value[field];
            if (typeof number !== 'number' || !Number.isFinite(number)) {
                throw new Error(`writeBatchStream receipt for ${value.path} has no ${field}`);
            }
            receipt[field] = number;
        }
        return receipt;
    });
}
/**
 * A view of `bytes` that owns its buffer: the stream transfers what it
 * enqueues, and a view sharing a buffer with anything else would detach it.
 */
function ownedBytes(bytes) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength)
        return bytes;
    return bytes.slice();
}
export class WaveWriter {
    options;
    records = new Map();
    directories = new Set();
    deletes = new Set();
    bufferedBytes = 0;
    symlinks = 0;
    /** Links in the wave in flight: sent, not yet published. */
    inFlightSymlinks = 0;
    /** Every path the buffered wave publishes; a superset once a buffered record is removed. */
    owned = new Set();
    /** The upward-closed part of `owned`: each one's chain, to the root, is owned too. */
    ownedDirectories = new Set();
    ownedPathBytes = 0;
    pin = null;
    inFlight = null;
    cutQueue = Promise.resolve();
    sequence = 0;
    failure = null;
    counters = {
        waves: 0,
        files: 0,
        bytes: 0,
        rpcWallMs: 0,
        maxRpcWallMs: 0,
        producerWaitMs: 0,
        ownershipVisits: 0,
        maxWavePaths: 0,
        maxWaveBytes: 0,
    };
    constructor(options) {
        this.options = options;
    }
    // ── Records ──────────────────────────────────────────────────────────
    /**
     * A regular file. The writer takes `bytes`; a view sharing its buffer is
     * copied. `meta` rides with the record, back to the caller as it is cut.
     */
    async file(path, mode, bytes, meta) {
        const key = this.key(path);
        await this.admit(key, bytes.byteLength, true);
        this.buffer(key, { kind: 'file', mode: mode & 0o111 ? 0o755 : 0o644, bytes: ownedBytes(bytes), meta });
        await this.cutIfFull();
    }
    /** A symbolic link to `target`. */
    async symlink(path, target, meta) {
        const key = this.key(path);
        const bytes = encoder.encode(target);
        await this.admit(key, bytes.byteLength, true);
        this.buffer(key, { kind: 'symlink', mode: 0o777, bytes, meta });
        await this.cutIfFull();
    }
    /**
     * A regular file of `size` bytes read from `chunks` as its wave drains:
     * the buffered wave is sent first, then this file travels alone, and the
     * call resolves once its source is consumed.
     */
    async fileChunks(path, mode, size, chunks, meta) {
        if (!Number.isSafeInteger(size) || size < 0)
            throw new Error(`git write: ${path}: invalid size ${size}`);
        const key = this.key(path);
        this.assertHealthy();
        if (this.hasBuffered())
            await this.cut();
        this.buffer(key, { kind: 'stream', mode: mode & 0o111 ? 0o755 : 0o644, size, source: chunks, meta });
        await this.cut();
        if (this.inFlight)
            await this.inFlight;
    }
    /** A directory (an empty one, a gitlink): files' directories need no record. */
    async directory(path) {
        const key = this.key(path);
        await this.admit(key, 0, true);
        this.directories.add(key);
        this.deletes.delete(key);
        const tally = this.tally();
        this.ownPath(key, true, tally);
        this.walkChain(key, true, tally);
        this.ownedPathBytes = tally.pathBytes;
        await this.cutIfFull();
    }
    /**
     * Remove what stands at `path`, its subtree included. A buffered record at
     * the path is dropped; with `directory`, a buffered mkdir of it too.
     */
    async remove(path, directory = false) {
        const key = this.key(path);
        await this.admit(key, 0, false);
        this.drop(key);
        if (directory)
            this.directories.delete(key);
        this.deletes.add(key);
        const tally = this.tally();
        this.ownPath(key, true, tally);
        this.ownedPathBytes = tally.pathBytes;
        await this.cutIfFull();
    }
    /**
     * A file every wave re-asserts until a wave carrying it publishes (a
     * clone's ownership marker): parent directories publish independently of
     * files, so each wave leaves the marker's proof in place. `durable` says
     * these bytes are already published.
     */
    setPin(path, text, durable = false) {
        this.pin = { path: this.key(path), bytes: encoder.encode(text), durable };
    }
    clearPin(path) {
        if (this.pin && this.pin.path === this.key(path))
            this.pin = null;
    }
    // ── The buffered wave, for a reader that must see it ─────────────────
    /** The bytes buffered at `path`, if a file or link is. */
    buffered(path) {
        const record = this.records.get(path);
        return record && record.kind !== 'stream' ? record.bytes : undefined;
    }
    /** The buffered file or link at `path`: its kind, size and the caller's `meta`. */
    bufferedRecord(path) {
        const record = this.records.get(path);
        if (record === undefined)
            return undefined;
        return record.kind === 'stream'
            ? { kind: 'file', size: record.size, meta: record.meta }
            : { kind: record.kind, size: record.bytes.byteLength, meta: record.meta };
    }
    isBufferedDirectory(path) {
        return this.directories.has(path);
    }
    isBufferedDelete(path) {
        return this.deletes.has(path);
    }
    bufferedPaths() {
        return { files: this.records.keys(), directories: this.directories, deletes: this.deletes };
    }
    /** Whether a link is buffered or in flight: written, not yet published. */
    get hasUnpublishedSymlinks() {
        return this.symlinks > 0 || this.inFlightSymlinks > 0;
    }
    // ── Publication ──────────────────────────────────────────────────────
    /** Every record accepted so far is durable; rejects with the first failed wave. */
    async flush() {
        await this.cut();
        if (this.inFlight)
            await this.inFlight;
        this.assertHealthy();
    }
    /** The wave in flight has settled; nothing new is cut. */
    async settled() {
        if (this.inFlight)
            await this.inFlight.catch(() => { });
        this.assertHealthy();
    }
    assertHealthy() {
        if (this.failure)
            throw this.failure;
    }
    get failed() {
        return this.failure;
    }
    stats() {
        return { ...this.counters };
    }
    // ── Internals ────────────────────────────────────────────────────────
    key(path) {
        return this.options.base ? this.options.base + '/' + path : path;
    }
    tally() {
        return { pathCount: this.owned.size, pathBytes: this.ownedPathBytes };
    }
    hasBuffered() {
        return this.records.size > 0 || this.directories.size > 0 || this.deletes.size > 0;
    }
    ownPath(path, admit, tally) {
        this.counters.ownershipVisits++;
        if (this.owned.has(path))
            return;
        tally.pathCount++;
        tally.pathBytes += encoder.encode(path).byteLength;
        if (admit)
            this.owned.add(path);
    }
    /** collectDirectoryPaths' chain from `path` upward, to the first directory already owned. */
    walkChain(path, admit, tally) {
        const { root, worktreeRoot = null } = this.options;
        let current = path;
        while (current) {
            if (root && current !== root && !current.startsWith(root + '/'))
                break;
            if (worktreeRoot !== null && !current.startsWith(worktreeRoot + '/'))
                break;
            this.counters.ownershipVisits++;
            if (this.ownedDirectories.has(current))
                break;
            if (admit)
                this.ownedDirectories.add(current);
            if (!this.owned.has(current)) {
                tally.pathCount++;
                tally.pathBytes += encoder.encode(current).byteLength;
                if (admit)
                    this.owned.add(current);
            }
            if (current === root)
                break;
            current = parentOf(current);
        }
    }
    /** Cut waves until `path` (with its chain) and `bytes` fit beside what is buffered. */
    async admit(path, bytes, withParents) {
        this.assertHealthy();
        while (this.hasBuffered()) {
            const tally = this.tally();
            this.ownPath(path, false, tally);
            if (withParents)
                this.walkChain(parentOf(path), false, tally);
            const replaced = this.records.get(path);
            const replacedBytes = replaced && replaced.kind !== 'stream' ? replaced.bytes.byteLength : 0;
            if (this.bufferedBytes - replacedBytes + bytes <= WAVE_BYTES &&
                tally.pathCount < WAVE_PATHS &&
                tally.pathBytes < WAVE_PATH_BYTES)
                return;
            await this.cut();
        }
        const tally = this.tally();
        this.ownPath(path, false, tally);
        if (withParents)
            this.walkChain(parentOf(path), false, tally);
        if (tally.pathCount > W7_MAX_PATHS_PER_BATCH) {
            throw new Error('git write wave exceeds ' + W7_MAX_PATHS_PER_BATCH + ' owned paths');
        }
        if (tally.pathBytes > W7_MAX_OWNED_PATH_BYTES) {
            throw new Error('git write wave exceeds ' + W7_MAX_OWNED_PATH_BYTES + ' owned path bytes');
        }
    }
    buffer(path, record) {
        this.drop(path);
        this.deletes.delete(path);
        this.records.set(path, record);
        if (record.kind === 'symlink')
            this.symlinks++;
        if (record.kind !== 'stream')
            this.bufferedBytes += record.bytes.byteLength;
        const tally = this.tally();
        this.ownPath(path, true, tally);
        this.walkChain(parentOf(path), true, tally);
        this.ownedPathBytes = tally.pathBytes;
    }
    drop(path) {
        const previous = this.records.get(path);
        if (!previous)
            return;
        if (previous.kind === 'symlink')
            this.symlinks--;
        if (previous.kind !== 'stream')
            this.bufferedBytes -= previous.bytes.byteLength;
        this.records.delete(path);
    }
    async cutIfFull() {
        if (this.owned.size >= WAVE_PATHS ||
            this.ownedPathBytes >= WAVE_PATH_BYTES ||
            this.bufferedBytes >= WAVE_BYTES) {
            await this.cut();
        }
    }
    /**
     * Send the buffered wave once the one in flight has published. Cuts are
     * serialised, so at most one wave is in flight and one buffers.
     */
    cut() {
        const run = this.cutQueue.then(() => this.cutNow());
        this.cutQueue = run.catch(() => { });
        return run;
    }
    async cutNow() {
        if (this.inFlight) {
            const waitStarted = Date.now();
            await this.inFlight.catch(() => { });
            this.counters.producerWaitMs += Date.now() - waitStarted;
        }
        this.assertHealthy();
        this.bufferPin();
        if (!this.hasBuffered())
            return;
        // A wave already sent can still publish after the deadline; none starts after it.
        const { deadline = null } = this.options;
        if (deadline !== null && Date.now() >= deadline) {
            throw new Error('git clone phase deadline reached before starting a new write wave');
        }
        const wave = ++this.sequence;
        const sentPin = this.pin;
        const mtime = this.options.mtimeMs ?? Date.now();
        const files = [];
        const directories = this.publishedDirectories();
        const inodes = [];
        const chunks = [];
        const streams = [];
        let waveBytes = 0;
        for (const dir of directories) {
            inodes.push({
                path: dir, parentPath: parentOf(dir), kind: 'directory', isDir: true,
                size: 0, mtime, mode: this.options.directoryMode?.(dir) ?? 0o755, chunkCount: 0,
            });
        }
        for (const [path, record] of this.records) {
            files.push({ path, meta: record.meta });
            const size = record.kind === 'stream' ? record.size : record.bytes.byteLength;
            const chunkCount = size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
            waveBytes += size;
            inodes.push({
                path, parentPath: parentOf(path),
                kind: record.kind === 'symlink' ? 'symlink' : 'file',
                isDir: false, size, mtime, mode: record.mode, chunkCount,
            });
            if (record.kind === 'stream') {
                streams.push({ path, source: record.source });
                continue;
            }
            const data = record.bytes;
            if (size === 0)
                continue;
            if (size <= CHUNK_SIZE) {
                chunks.push({ path, chunkId: 0, data });
                continue;
            }
            // One chunk-sized copy at a time, made as the encoder reaches it: an
            // eager copy per chunk would hold the file twice (a packfile's peak).
            for (let chunkId = 0; chunkId < chunkCount; chunkId++) {
                const start = chunkId * CHUNK_SIZE;
                const end = Math.min(size, start + CHUNK_SIZE);
                chunks.push({ path, chunkId, get data() { return data.slice(start, end); } });
            }
        }
        const deletePaths = this.deletes.size > 0 ? [...this.deletes] : undefined;
        const paths = this.owned.size;
        const symlinks = this.symlinks;
        this.options.onCut?.({ wave, mtimeMs: mtime, files, directories });
        // The payload holds the wave's bytes now; the buffer lets go of them so
        // the facet holds one copy while the stream drains.
        this.records.clear();
        this.directories.clear();
        this.deletes.clear();
        this.owned.clear();
        this.ownedDirectories.clear();
        this.ownedPathBytes = 0;
        this.bufferedBytes = 0;
        this.symlinks = 0;
        this.counters.maxWavePaths = Math.max(this.counters.maxWavePaths, paths);
        this.counters.maxWaveBytes = Math.max(this.counters.maxWaveBytes, waveBytes);
        const stream = encodeWriteBatchStream({ inodes, chunks, deletePaths, streams });
        this.inFlightSymlinks = symlinks;
        const sentAt = Date.now();
        const published = this.options.supervisor.writeBatchStream(stream).then((result) => {
            try {
                const error = waveResultError(result);
                if (error)
                    throw error;
                const rpcWallMs = Date.now() - sentAt;
                if (sentPin !== null && this.pin === sentPin)
                    sentPin.durable = true;
                this.inFlightSymlinks = 0;
                this.counters.waves++;
                this.counters.files += files.length;
                this.counters.bytes += waveBytes;
                this.counters.rpcWallMs += rpcWallMs;
                this.counters.maxRpcWallMs = Math.max(this.counters.maxRpcWallMs, rpcWallMs);
                this.options.onWave?.({ wave, files: files.length, bytes: waveBytes, rpcWallMs, receipts: parseReceipts(result) });
            }
            finally {
                disposeRpcResource(result);
            }
        }).catch((error) => {
            const failure = error instanceof WaveFailure ? error : new WaveFailure(wave, error);
            if (this.failure === null)
                this.failure = failure;
            throw this.failure;
        }).finally(() => {
            if (this.inFlight === published)
                this.inFlight = null;
        });
        // Its failure reaches whoever waits next; it is never unobserved.
        published.catch(() => { });
        this.inFlight = published;
    }
    /** The directories the buffered records publish, shallowest first. */
    publishedDirectories() {
        const dirs = new Set();
        const { root, worktreeRoot = null } = this.options;
        const collect = (path) => {
            let current = path;
            while (current) {
                if (root && current !== root && !current.startsWith(root + '/'))
                    break;
                if (worktreeRoot !== null && !current.startsWith(worktreeRoot + '/'))
                    break;
                if (dirs.has(current))
                    break;
                dirs.add(current);
                if (current === root)
                    break;
                current = parentOf(current);
            }
        };
        for (const path of this.records.keys())
            collect(parentOf(path));
        for (const dir of this.directories)
            collect(dir);
        return [...dirs].sort((left, right) => {
            const depth = left.split('/').length - right.split('/').length;
            return depth || (left < right ? -1 : left > right ? 1 : 0);
        });
    }
    bufferPin() {
        const pin = this.pin;
        if (!pin)
            return;
        // A durable pin asserts presence, not churn: re-writing identical bytes
        // re-arms the receiver's content GC for no change. Re-buffer only when a
        // buffered record claims the path.
        if (pin.durable && !this.records.has(pin.path) && !this.deletes.has(pin.path))
            return;
        this.buffer(pin.path, { kind: 'file', mode: 0o644, bytes: pin.bytes.slice(), meta: undefined });
    }
}
export function createWaveWriter(options) {
    return new WaveWriter(options);
}
