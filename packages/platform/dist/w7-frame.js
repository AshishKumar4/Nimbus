/**
 * W7 v3 — incremental typed records for streamed bulk filesystem writes.
 * The format is internal: every producer and consumer deploys together.
 */
import { crc32 } from './crc32.js';
import { CHUNK_SIZE } from './limits.js';
import { utf8Length } from './utf8.js';
export const W7_MAGIC = new Uint8Array([0x4e, 0x57, 0x37, 0x03]);
const ENCODER_QUEUE_HWM = 0;
const ENCODER_PULL_BYTES = 256 * 1024;
/** What one stream read asks for when a record's small fields are wanted. */
const READ_AHEAD_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 64 * 1024;
const MAX_BATCH_ID_BYTES = 128;
const MAX_CONTENT_ID_BYTES = 256;
/**
 * A batch's owned paths. Each stream costs the receiver a round trip and a
 * publication's fixed work, so a batch is as wide as its byte budget allows;
 * ownership is a set of names, small beside the bytes.
 */
export const W7_MAX_PATHS_PER_BATCH = 1024;
export const W7_MAX_OWNED_PATH_BYTES = 256 * 1024;
export const W7_MAX_RECORD_BYTES = 5 + 4 + MAX_CONTENT_ID_BYTES + 8 + CHUNK_SIZE;
/** The wire chunks a file or link of `size` bytes travels as: CHUNK_SIZE each, the last short, none when empty. */
export function w7ChunkCount(size) {
    return size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
}
/** `data`, the content at `path`, as its wire chunks (w7ChunkCount): views of it, not copies. */
export function w7Chunks(path, data) {
    const chunks = [];
    for (let chunkId = 0, count = w7ChunkCount(data.byteLength); chunkId < count; chunkId++) {
        chunks.push({ path, chunkId, data: data.subarray(chunkId * CHUNK_SIZE, (chunkId + 1) * CHUNK_SIZE) });
    }
    return chunks;
}
var RecordTag;
(function (RecordTag) {
    RecordTag[RecordTag["BatchBegin"] = 1] = "BatchBegin";
    RecordTag[RecordTag["Delete"] = 2] = "Delete";
    RecordTag[RecordTag["Directory"] = 3] = "Directory";
    RecordTag[RecordTag["FileBegin"] = 4] = "FileBegin";
    RecordTag[RecordTag["FileChunk"] = 5] = "FileChunk";
    RecordTag[RecordTag["FileEnd"] = 6] = "FileEnd";
    RecordTag[RecordTag["BatchEnd"] = 7] = "BatchEnd";
})(RecordTag || (RecordTag = {}));
const MODE = 'path-atomic-committed-prefix';
/**
 * Encode the records a pull reaches into one enqueued chunk of about
 * ENCODER_PULL_BYTES (a record never splits; a file's chunk is at most
 * CHUNK_SIZE), so a wave crosses the RPC boundary in a few writes rather than
 * one per record. The bytes are the same records either way; no batch-sized
 * metadata header exists.
 */
export function encodeWriteBatchStream(payload) {
    const batchId = crypto.randomUUID();
    const { deletes, directories, files } = preparePayload(payload, batchId);
    const iterator = encodeRecords(batchId, deletes, directories, files);
    let closed = false;
    let magicEmitted = false;
    const source = {
        type: 'bytes',
        async pull(controller) {
            if (closed)
                return;
            try {
                const parts = [];
                let bytes = 0;
                if (!magicEmitted) {
                    magicEmitted = true;
                    parts.push(W7_MAGIC.slice());
                    bytes += W7_MAGIC.byteLength;
                }
                while (bytes < ENCODER_PULL_BYTES) {
                    const next = await iterator.next();
                    if (next.done) {
                        closed = true;
                        break;
                    }
                    for (const part of next.value) {
                        parts.push(part);
                        bytes += part.byteLength;
                    }
                }
                // Every chunk enqueued is one the encoder built: a lone part is the
                // magic or a metadata record, and a file chunk's record is always
                // two parts, so its bytes are copied here. A caller's buffers are
                // never transferred, and a payload may be encoded again.
                if (bytes > 0)
                    controller.enqueue(parts.length === 1 ? parts[0] : concatBytes(...parts));
                if (closed)
                    controller.close();
            }
            catch (error) {
                closed = true;
                controller.error(error);
            }
        },
        cancel() {
            closed = true;
            iterator.return?.(undefined);
        },
    };
    return new ReadableStream(source, {
        highWaterMark: ENCODER_QUEUE_HWM,
    });
}
/**
 * Parse the v3 preamble eagerly, then expose validated operation records
 * incrementally. Chunk credit is acquired after its bounded header validates
 * and before its payload bytes are read or copied.
 */
export async function decodeWriteBatchStream(stream, options = {}) {
    let reader;
    try {
        reader = stream.getReader({ mode: 'byob' });
    }
    catch {
        throw new Error('w7-frame: stream must be a byte-oriented ReadableStream');
    }
    const buffer = new ExactByteReader(reader, options.signal);
    let handedOff = false;
    try {
        throwIfAborted(options.signal);
        const magic = await buffer.readExact(W7_MAGIC.length, 'magic');
        if (!bytesEqual(magic, W7_MAGIC)) {
            const version = magic.length === 4
                && magic[0] === 0x4e && magic[1] === 0x57 && magic[2] === 0x37
                ? magic[3]
                : null;
            if (version !== null) {
                throw new Error(`w7-frame: unsupported protocol version ${version}; expected 3`);
            }
            throw new Error(`w7-frame: bad magic, expected NW7\\x03, got ${hex(magic)}`);
        }
        const beginEnvelope = await readEnvelope(buffer, 'batch-begin');
        if (beginEnvelope.tag !== RecordTag.BatchBegin) {
            throw new Error(`w7-frame: first record must be batch-begin, got tag ${beginEnvelope.tag}`);
        }
        if (beginEnvelope.length > MAX_METADATA_BYTES) {
            throw new Error(`w7-frame: batch-begin length ${beginEnvelope.length} exceeds ${MAX_METADATA_BYTES}`);
        }
        const beginPayload = await buffer.readExact(beginEnvelope.length, 'batch-begin payload');
        const begin = parseBatchBegin(beginPayload);
        const initialCheck = updateRecordCheck(0, beginEnvelope.header, beginPayload);
        handedOff = true;
        return {
            batchId: begin.id,
            mode: begin.mode,
            records: decodeRecords(stream, reader, buffer, options, initialCheck),
        };
    }
    catch (error) {
        if (!handedOff)
            await cancelReader(reader, error);
        throw error;
    }
}
async function* decodeRecords(stream, reader, buffer, options, initialCheck) {
    const ownedPaths = new PathOwnership();
    const contentIds = new Set();
    let active = null;
    let batchCheck = initialCheck;
    const summary = {
        recordCount: 1,
        pathCount: 0,
        deleteCount: 0,
        directoryCount: 0,
        fileCount: 0,
        chunkCount: 0,
        byteCount: 0,
    };
    let completed = false;
    let failure = new DOMException('W7 consumer cancelled', 'AbortError');
    try {
        while (true) {
            throwIfAborted(options.signal);
            const envelope = await readEnvelope(buffer, 'record');
            if (active && envelope.tag !== RecordTag.FileChunk && envelope.tag !== RecordTag.FileEnd) {
                throw new Error(`w7-frame: file ${active.inode.path} ended without file-end`);
            }
            if (envelope.tag === RecordTag.FileChunk) {
                if (!active)
                    throw new Error('w7-frame: file-chunk without active file');
                // The chunk must name its file's content id, so its prefix is that
                // id's length plus the id-length, chunk-id and data-length fields:
                // read whole, then checked field by field.
                const expectedId = active.contentIdBytes;
                const prefixLength = 4 + expectedId.byteLength + 8;
                if (prefixLength > envelope.length) {
                    throw new Error('w7-frame: malformed file-chunk record length');
                }
                const headerPayload = await buffer.readExact(prefixLength, 'file-chunk header');
                const idLength = readU32LE(headerPayload, 0);
                if (idLength === 0 || idLength > MAX_CONTENT_ID_BYTES) {
                    throw new Error(`w7-frame: invalid file-chunk content-id length ${idLength}`);
                }
                if (idLength !== expectedId.byteLength || !sameBytes(headerPayload.subarray(4, 4 + idLength), expectedId)) {
                    throw new Error(`w7-frame: file-chunk content id does not own ${active.inode.path}`);
                }
                const chunkId = readU32LE(headerPayload, 4 + idLength);
                const dataLength = readU32LE(headerPayload, 8 + idLength);
                if (envelope.length !== 4 + idLength + 8 + dataLength) {
                    throw new Error('w7-frame: file-chunk payload length mismatch');
                }
                const contentId = active.metadata.contentId;
                if (chunkId !== active.nextChunkId) {
                    throw new Error(`w7-frame: ${active.inode.path}: expected chunk ${active.nextChunkId}, got ${chunkId}`);
                }
                if (chunkId >= active.inode.chunkCount) {
                    throw new Error(`w7-frame: ${active.inode.path}: chunk ${chunkId} is out of range`);
                }
                const expectedBytes = Math.min(CHUNK_SIZE, active.inode.size - (chunkId * CHUNK_SIZE));
                if (dataLength !== expectedBytes || dataLength > CHUNK_SIZE) {
                    throw new Error(`w7-frame: ${active.inode.path}: chunk ${chunkId} has ${dataLength} bytes; expected ${expectedBytes}`);
                }
                let retention = null;
                try {
                    retention = options.retainChunk
                        ? await options.retainChunk(dataLength, options.signal)
                        : noopRetention(dataLength);
                    throwIfAborted(options.signal);
                    const data = await buffer.readExact(dataLength, 'file-chunk data');
                    batchCheck = updateRecordCheck(batchCheck, envelope.header, headerPayload, data);
                    active.check = crc32(data, active.check);
                    active.nextChunkId++;
                    active.receivedBytes += dataLength;
                    summary.recordCount++;
                    summary.chunkCount++;
                    summary.byteCount += dataLength;
                    const record = {
                        type: 'file-chunk',
                        streamContentId: contentId,
                        path: active.inode.path,
                        chunkId,
                        data,
                        retention,
                    };
                    retention = null;
                    yield record;
                }
                finally {
                    retention?.release();
                }
                continue;
            }
            if (envelope.length > MAX_METADATA_BYTES) {
                throw new Error(`w7-frame: metadata record length ${envelope.length} exceeds ${MAX_METADATA_BYTES}`);
            }
            const payload = await buffer.readExact(envelope.length, 'record payload');
            if (envelope.tag !== RecordTag.BatchEnd) {
                batchCheck = updateRecordCheck(batchCheck, envelope.header, payload);
                summary.recordCount++;
            }
            switch (envelope.tag) {
                case RecordTag.Delete: {
                    const metadata = parseDelete(payload);
                    claimPath(ownedPaths, metadata.path);
                    summary.pathCount++;
                    summary.deleteCount++;
                    yield { type: 'delete', path: metadata.path };
                    break;
                }
                case RecordTag.Directory: {
                    const metadata = parseDirectory(payload);
                    claimPath(ownedPaths, metadata.path);
                    summary.pathCount++;
                    summary.directoryCount++;
                    yield { type: 'directory', inode: directoryInode(metadata) };
                    break;
                }
                case RecordTag.FileBegin: {
                    const metadata = parseFileBegin(payload);
                    claimPath(ownedPaths, metadata.path);
                    if (contentIds.has(metadata.contentId)) {
                        throw new Error(`w7-frame: duplicate stream content id ${metadata.contentId}`);
                    }
                    contentIds.add(metadata.contentId);
                    const inode = fileInode(metadata);
                    summary.pathCount++;
                    summary.fileCount++;
                    active = {
                        metadata,
                        contentIdBytes: TEXT_ENCODER.encode(metadata.contentId),
                        inode,
                        nextChunkId: 0,
                        receivedBytes: 0,
                        check: 0,
                    };
                    yield { type: 'file-begin', streamContentId: metadata.contentId, inode };
                    break;
                }
                case RecordTag.FileEnd: {
                    if (!active)
                        throw new Error('w7-frame: file-end without active file');
                    const metadata = parseFileEnd(payload);
                    const actualCheck = active.check;
                    if (metadata.contentId !== active.metadata.contentId) {
                        throw new Error(`w7-frame: file-end content id mismatch for ${active.inode.path}`);
                    }
                    if (metadata.size !== active.receivedBytes || metadata.size !== active.inode.size) {
                        throw new Error(`w7-frame: file-end byte total mismatch for ${active.inode.path}`);
                    }
                    if (metadata.chunkCount !== active.nextChunkId
                        || metadata.chunkCount !== active.inode.chunkCount) {
                        throw new Error(`w7-frame: file-end chunk count mismatch for ${active.inode.path}`);
                    }
                    if (metadata.check !== actualCheck) {
                        throw new Error(`w7-frame: file-end check mismatch for ${active.inode.path}`);
                    }
                    const record = {
                        type: 'file-end',
                        streamContentId: metadata.contentId,
                        path: active.inode.path,
                        size: metadata.size,
                        chunkCount: metadata.chunkCount,
                        check: metadata.check,
                    };
                    active = null;
                    yield record;
                    break;
                }
                case RecordTag.BatchEnd: {
                    if (active)
                        throw new Error(`w7-frame: batch-end while file ${active.inode.path} is active`);
                    const actual = parseBatchEnd(payload);
                    const expected = { ...summary, check: batchCheck };
                    if (!sameSummary(actual, expected)) {
                        throw new Error(`w7-frame: batch-end summary mismatch; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
                    }
                    await buffer.ensureEof(stream);
                    completed = true;
                    yield { type: 'batch-end', summary: actual };
                    return;
                }
                case RecordTag.BatchBegin:
                    throw new Error('w7-frame: duplicate batch-begin');
                default:
                    throw new Error(`w7-frame: unknown record tag ${envelope.tag}`);
            }
        }
    }
    catch (error) {
        failure = error;
        throw error;
    }
    finally {
        if (completed) {
            try {
                reader.releaseLock();
            }
            catch { /* already released */ }
        }
        else {
            await cancelReader(reader, failure);
        }
    }
}
async function* encodeRecords(batchId, deletes, directories, files) {
    const state = {
        batchCheck: 0,
        summary: {
            recordCount: 0,
            pathCount: 0,
            deleteCount: 0,
            directoryCount: 0,
            fileCount: 0,
            chunkCount: 0,
            byteCount: 0,
        },
    };
    yield encodeMetadataRecord(RecordTag.BatchBegin, { id: batchId, mode: MODE }, state);
    for (const path of deletes) {
        state.summary.pathCount++;
        state.summary.deleteCount++;
        yield encodeMetadataRecord(RecordTag.Delete, { path }, state);
    }
    for (const inode of directories) {
        state.summary.pathCount++;
        state.summary.directoryCount++;
        yield encodeMetadataRecord(RecordTag.Directory, {
            ...inodeMetadata(inode),
            kind: inode.kind,
        }, state);
    }
    for (const file of files) {
        state.summary.pathCount++;
        state.summary.fileCount++;
        yield encodeMetadataRecord(RecordTag.FileBegin, {
            ...inodeMetadata(file.inode),
            kind: file.inode.kind,
            contentId: file.contentId,
            size: file.inode.size,
            chunkCount: file.inode.chunkCount,
        }, state);
        let fileCheck = 0;
        let chunkId = 0;
        const pieces = file.source === null ? givenChunks(file.chunks) : fixedChunks(file.inode, file.source);
        for await (const data of pieces) {
            const contentBytes = new TextEncoder().encode(file.contentId);
            const prefix = new Uint8Array(4 + contentBytes.length + 8);
            writeU32LE(prefix, 0, contentBytes.length);
            prefix.set(contentBytes, 4);
            writeU32LE(prefix, 4 + contentBytes.length, chunkId++);
            writeU32LE(prefix, 8 + contentBytes.length, data.byteLength);
            const header = recordHeader(RecordTag.FileChunk, prefix.byteLength + data.byteLength);
            state.batchCheck = updateRecordCheck(state.batchCheck, header, prefix, data);
            state.summary.recordCount++;
            state.summary.chunkCount++;
            state.summary.byteCount += data.byteLength;
            fileCheck = crc32(data, fileCheck);
            yield [concatBytes(header, prefix), data];
        }
        yield encodeMetadataRecord(RecordTag.FileEnd, {
            contentId: file.contentId,
            size: file.inode.size,
            chunkCount: file.inode.chunkCount,
            check: fileCheck,
        }, state);
    }
    const end = {
        ...state.summary,
        check: state.batchCheck,
    };
    yield encodeMetadataRecord(RecordTag.BatchEnd, end);
}
/** Each chunk's bytes, read as the encoder reaches it (a producer's `data` may copy on access). */
function* givenChunks(chunks) {
    for (const chunk of chunks)
        yield chunk.data;
}
/**
 * A streamed file's bytes as the wire's positional chunks: CHUNK_SIZE each but
 * the last, every one over its own buffer (the stream transfers what it
 * enqueues). The source must yield exactly the inode's size.
 */
async function* fixedChunks(inode, source) {
    let pending = new Uint8Array(Math.min(CHUNK_SIZE, inode.size));
    let filled = 0;
    let total = 0;
    for await (const part of source) {
        if (!(part instanceof Uint8Array))
            throw new Error(`w7-frame: ${inode.path}: streamed piece is not bytes`);
        if (total + part.byteLength > inode.size) {
            throw new Error(`w7-frame: ${inode.path}: streamed source exceeds its ${inode.size} bytes`);
        }
        total += part.byteLength;
        for (let offset = 0; offset < part.byteLength;) {
            const take = Math.min(pending.byteLength - filled, part.byteLength - offset);
            pending.set(part.subarray(offset, offset + take), filled);
            filled += take;
            offset += take;
            if (filled === pending.byteLength) {
                yield pending;
                pending = new Uint8Array(Math.min(CHUNK_SIZE, inode.size - total + (part.byteLength - offset)));
                filled = 0;
            }
        }
    }
    if (total !== inode.size) {
        throw new Error(`w7-frame: ${inode.path}: streamed source ended at ${total} of ${inode.size} bytes`);
    }
}
function encodeMetadataRecord(tag, value, state) {
    const payload = new TextEncoder().encode(JSON.stringify(value));
    if (payload.byteLength > MAX_METADATA_BYTES) {
        throw new Error(`w7-frame: metadata record exceeds ${MAX_METADATA_BYTES} bytes`);
    }
    const header = recordHeader(tag, payload.byteLength);
    if (state && tag !== RecordTag.BatchEnd) {
        state.batchCheck = updateRecordCheck(state.batchCheck, header, payload);
        state.summary.recordCount++;
    }
    return [concatBytes(header, payload)];
}
function preparePayload(payload, batchId) {
    if (!payload || !Array.isArray(payload.inodes) || !Array.isArray(payload.chunks)) {
        throw new Error('w7-frame: payload must contain inode and chunk arrays');
    }
    const ownedPaths = new PathOwnership();
    const deletes = [...(payload.deletePaths ?? [])];
    for (const path of deletes)
        claimPath(ownedPaths, canonicalPath(path, 'delete path'));
    const streamsByPath = new Map();
    for (const stream of payload.streams ?? []) {
        const path = canonicalPath(stream.path, 'stream path');
        if (streamsByPath.has(path))
            throw new Error(`w7-frame: duplicate stream for ${path}`);
        streamsByPath.set(path, stream.source);
    }
    const chunksByPath = new Map();
    for (const chunk of payload.chunks) {
        const path = canonicalPath(chunk.path, 'chunk path');
        const list = chunksByPath.get(path);
        if (list)
            list.push(chunk);
        else
            chunksByPath.set(path, [chunk]);
    }
    const directories = [];
    const files = [];
    let fileIndex = 0;
    for (const inode of payload.inodes) {
        const path = canonicalPath(inode.path, 'inode path');
        if (path !== inode.path)
            throw new Error(`w7-frame: noncanonical inode path ${inode.path}`);
        claimPath(ownedPaths, path);
        const normalizedInode = normalizeInode(inode);
        const fileChunks = chunksByPath.get(path) ?? [];
        const streamed = streamsByPath.get(path) ?? null;
        if (normalizedInode.kind === 'directory') {
            if (fileChunks.length > 0 || streamed !== null)
                throw new Error(`w7-frame: directory ${path} has chunks`);
            directories.push(normalizedInode);
        }
        else {
            if (streamed === null)
                validateChunks(normalizedInode, fileChunks);
            else if (fileChunks.length > 0)
                throw new Error(`w7-frame: streamed file ${path} also has chunks`);
            files.push({
                inode: normalizedInode,
                contentId: `${batchId}:${fileIndex++}`,
                chunks: fileChunks,
                source: streamed,
            });
        }
        chunksByPath.delete(path);
        streamsByPath.delete(path);
    }
    if (chunksByPath.size > 0) {
        throw new Error(`w7-frame: chunk has no inode: ${chunksByPath.keys().next().value}`);
    }
    if (streamsByPath.size > 0) {
        throw new Error(`w7-frame: stream has no inode: ${streamsByPath.keys().next().value}`);
    }
    return { deletes, directories, files };
}
function parseBatchBegin(bytes) {
    const value = parseObject(bytes, 'batch-begin', ['id', 'mode']);
    const id = boundedString(value.id, 'batch id', MAX_BATCH_ID_BYTES);
    if (value.mode !== MODE)
        throw new Error(`w7-frame: unsupported batch mode ${String(value.mode)}`);
    return { id, mode: MODE };
}
function parseDelete(bytes) {
    const value = parseObject(bytes, 'delete', ['path']);
    return { path: canonicalPath(value.path, 'delete path') };
}
function parseDirectory(bytes) {
    const value = parseObject(bytes, 'directory', ['path', 'kind', 'mtime', 'mode'], ['atime']);
    if (value.kind !== 'directory') {
        throw new Error(`w7-frame: unsupported directory kind ${String(value.kind)}`);
    }
    return { ...parseInodeMetadata(value, 'directory'), kind: 'directory' };
}
function parseFileBegin(bytes) {
    const value = parseObject(bytes, 'file-begin', ['path', 'kind', 'contentId', 'size', 'chunkCount', 'mtime', 'mode'], ['atime']);
    const base = parseInodeMetadata(value, 'file-begin');
    if (value.kind !== 'file' && value.kind !== 'symlink') {
        throw new Error(`w7-frame: unsupported file-begin kind ${String(value.kind)}`);
    }
    const contentId = boundedString(value.contentId, 'stream content id', MAX_CONTENT_ID_BYTES);
    if (!/^[A-Za-z0-9._:-]+$/.test(contentId)) {
        throw new Error(`w7-frame: invalid stream content id ${contentId}`);
    }
    const size = safeInteger(value.size, 'file size');
    const chunkCount = u32(value.chunkCount, 'file chunk count');
    const expected = w7ChunkCount(size);
    if (chunkCount !== expected) {
        throw new Error(`w7-frame: ${base.path}: expected ${expected} chunks, got ${chunkCount}`);
    }
    return { ...base, kind: value.kind, contentId, size, chunkCount };
}
function parseFileEnd(bytes) {
    const value = parseObject(bytes, 'file-end', ['contentId', 'size', 'chunkCount', 'check']);
    return {
        contentId: boundedString(value.contentId, 'stream content id', MAX_CONTENT_ID_BYTES),
        size: safeInteger(value.size, 'file-end size'),
        chunkCount: u32(value.chunkCount, 'file-end chunk count'),
        check: u32(value.check, 'file-end check'),
    };
}
function parseBatchEnd(bytes) {
    const keys = [
        'recordCount', 'pathCount', 'deleteCount', 'directoryCount',
        'fileCount', 'chunkCount', 'byteCount', 'check',
    ];
    const value = parseObject(bytes, 'batch-end', keys);
    return {
        recordCount: safeInteger(value.recordCount, 'batch record count'),
        pathCount: safeInteger(value.pathCount, 'batch path count'),
        deleteCount: safeInteger(value.deleteCount, 'batch delete count'),
        directoryCount: safeInteger(value.directoryCount, 'batch directory count'),
        fileCount: safeInteger(value.fileCount, 'batch file count'),
        chunkCount: safeInteger(value.chunkCount, 'batch chunk count'),
        byteCount: safeInteger(value.byteCount, 'batch byte count'),
        check: u32(value.check, 'batch check'),
    };
}
function parseInodeMetadata(value, label) {
    return {
        path: canonicalPath(value.path, `${label} path`),
        ...(value.atime === undefined ? {} : { atime: safeInteger(value.atime, `${label} atime`) }),
        mtime: safeInteger(value.mtime, `${label} mtime`),
        mode: u32(value.mode, `${label} mode`),
    };
}
function parseObject(bytes, label, required, optional = []) {
    let value;
    try {
        value = JSON.parse(decodeText(bytes, label));
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('w7-frame:'))
            throw error;
        throw new Error(`w7-frame: invalid ${label} JSON: ${errorMessage(error)}`);
    }
    if (!isObject(value) || Array.isArray(value))
        throw new Error(`w7-frame: ${label} must be an object`);
    const allowed = new Set([...required, ...optional]);
    for (const key of required) {
        if (!Object.hasOwn(value, key))
            throw new Error(`w7-frame: ${label} missing ${key}`);
    }
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            throw new Error(`w7-frame: ${label} has unknown field ${key}`);
    }
    return value;
}
function normalizeInode(inode) {
    canonicalPath(inode.path, 'inode path');
    if (inode.parentPath !== parentPath(inode.path)) {
        throw new Error(`w7-frame: ${inode.path}: noncanonical parent path ${inode.parentPath}`);
    }
    safeInteger(inode.size, `${inode.path} size`);
    u32(inode.chunkCount, `${inode.path} chunk count`);
    safeInteger(inode.mtime, `${inode.path} mtime`);
    if (inode.atime !== undefined)
        safeInteger(inode.atime, `${inode.path} atime`);
    u32(inode.mode, `${inode.path} mode`);
    const rawKind = inode.kind ?? (inode.isDir ? 'directory' : 'file');
    if (rawKind !== 'file' && rawKind !== 'directory' && rawKind !== 'symlink') {
        throw new Error(`w7-frame: unsupported inode kind ${String(rawKind)}`);
    }
    const kind = rawKind;
    if (kind === 'directory' && !inode.isDir) {
        throw new Error(`w7-frame: directory inode ${inode.path} must be a directory`);
    }
    if (kind !== 'directory' && inode.isDir) {
        throw new Error(`w7-frame: ${kind} inode ${inode.path} cannot be a directory`);
    }
    if (kind === 'directory' && (inode.size !== 0 || inode.chunkCount !== 0)) {
        throw new Error(`w7-frame: directory ${inode.path} must have zero size and chunks`);
    }
    if (kind !== 'directory') {
        const expected = w7ChunkCount(inode.size);
        if (inode.chunkCount !== expected) {
            throw new Error(`w7-frame: ${inode.path}: expected ${expected} chunks, got ${inode.chunkCount}`);
        }
        return { ...inode, kind, isDir: false };
    }
    return { ...inode, kind, isDir: true };
}
function validateChunks(inode, chunks) {
    if (chunks.length !== inode.chunkCount) {
        throw new Error(`w7-frame: ${inode.path}: expected ${inode.chunkCount} chunks, got ${chunks.length}`);
    }
    chunks.sort((left, right) => left.chunkId - right.chunkId);
    for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        if (chunk.chunkId !== index) {
            throw new Error(`w7-frame: ${inode.path}: expected chunk ${index}, got ${chunk.chunkId}`);
        }
        const expected = Math.min(CHUNK_SIZE, inode.size - (index * CHUNK_SIZE));
        if (!(chunk.data instanceof Uint8Array) || chunk.data.byteLength !== expected) {
            throw new Error(`w7-frame: ${inode.path}: chunk ${index} must contain ${expected} bytes`);
        }
    }
}
function directoryInode(metadata) {
    return {
        path: metadata.path,
        parentPath: parentPath(metadata.path),
        kind: metadata.kind,
        isDir: true,
        size: 0,
        atime: metadata.atime,
        mtime: metadata.mtime,
        mode: metadata.mode,
        chunkCount: 0,
    };
}
function fileInode(metadata) {
    return {
        path: metadata.path,
        parentPath: parentPath(metadata.path),
        kind: metadata.kind,
        isDir: false,
        size: metadata.size,
        atime: metadata.atime,
        mtime: metadata.mtime,
        mode: metadata.mode,
        chunkCount: metadata.chunkCount,
    };
}
function inodeMetadata(inode) {
    return {
        path: inode.path,
        ...(inode.atime === undefined ? {} : { atime: inode.atime }),
        mtime: inode.mtime,
        mode: inode.mode,
    };
}
function canonicalPath(value, label) {
    const path = boundedString(value, label, MAX_PATH_BYTES);
    if (path.includes('\0'))
        throw new Error(`w7-frame: ${label} contains NUL`);
    const normalized = normalizePath(path);
    if (!path || normalized !== path)
        throw new Error(`w7-frame: noncanonical ${label}: ${path}`);
    return path;
}
class PathOwnership {
    paths = new Set();
    pathBytes = 0;
    claim(path) {
        if (this.paths.has(path))
            throw new Error(`w7-frame: duplicate path ownership: ${path}`);
        if (this.paths.size >= W7_MAX_PATHS_PER_BATCH) {
            throw new Error(`w7-frame: batch exceeds ${W7_MAX_PATHS_PER_BATCH} owned paths`);
        }
        const nextPathBytes = this.pathBytes + utf8Length(path);
        if (nextPathBytes > W7_MAX_OWNED_PATH_BYTES) {
            throw new Error(`w7-frame: owned path bytes exceed ${W7_MAX_OWNED_PATH_BYTES}`);
        }
        this.paths.add(path);
        this.pathBytes = nextPathBytes;
    }
}
function claimPath(paths, path) {
    paths.claim(path);
}
function normalizePath(path) {
    const out = [];
    for (const segment of path.split('/')) {
        if (segment === '..') {
            if (out.length > 0)
                out.pop();
        }
        else if (segment !== '' && segment !== '.') {
            out.push(segment);
        }
    }
    return out.join('/');
}
function parentPath(path) {
    const index = path.lastIndexOf('/');
    return index < 0 ? '' : path.slice(0, index);
}
function boundedString(value, label, maxBytes) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`w7-frame: ${label} must be a non-empty string`);
    }
    if (utf8Length(value) > maxBytes)
        throw new Error(`w7-frame: ${label} exceeds ${maxBytes} bytes`);
    return value;
}
function safeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`w7-frame: ${label} must be a non-negative safe integer`);
    }
    return value;
}
function u32(value, label) {
    const integer = safeInteger(value, label);
    if (integer > 0xffff_ffff)
        throw new Error(`w7-frame: ${label} exceeds uint32`);
    return integer;
}
function sameSummary(left, right) {
    return left.recordCount === right.recordCount
        && left.pathCount === right.pathCount
        && left.deleteCount === right.deleteCount
        && left.directoryCount === right.directoryCount
        && left.fileCount === right.fileCount
        && left.chunkCount === right.chunkCount
        && left.byteCount === right.byteCount
        && left.check === right.check;
}
async function readEnvelope(buffer, label) {
    const header = await buffer.readExact(5, `${label} header`);
    return { tag: header[0], length: readU32LE(header, 1), header };
}
function recordHeader(tag, length) {
    const header = new Uint8Array(5);
    header[0] = tag;
    writeU32LE(header, 1, length);
    return header;
}
function writeU32LE(out, offset, value) {
    out[offset] = value & 0xff;
    out[offset + 1] = (value >>> 8) & 0xff;
    out[offset + 2] = (value >>> 16) & 0xff;
    out[offset + 3] = (value >>> 24) & 0xff;
}
function readU32LE(bytes, offset) {
    return (bytes[offset]
        | (bytes[offset + 1] << 8)
        | (bytes[offset + 2] << 16)
        | (bytes[offset + 3] << 24)) >>> 0;
}
function updateRecordCheck(seed, ...parts) {
    let check = seed;
    for (const part of parts)
        check = crc32(part, check);
    return check;
}
function noopRetention(bytes) {
    return { bytes, release() { } };
}
// One decoder for every record: a non-streaming decode() starts from a
// clean state each call, so sharing it changes nothing but the cost of
// constructing one per record (three per small file).
// Both options stated: workers-types declares TextDecoderConstructorOptions
// with every property required, and ignoreBOM's default is false anyway.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
function decodeText(bytes, label) {
    try {
        return UTF8.decode(bytes);
    }
    catch (error) {
        throw new Error(`w7-frame: invalid UTF-8 in ${label}: ${errorMessage(error)}`);
    }
}
const TEXT_ENCODER = new TextEncoder();
function sameBytes(left, right) {
    if (left.byteLength !== right.byteLength)
        return false;
    for (let index = 0; index < left.byteLength; index++)
        if (left[index] !== right[index])
            return false;
    return true;
}
function concatBytes(...parts) {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}
function bytesEqual(left, right) {
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function hex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function throwIfAborted(signal) {
    if (!signal?.aborted)
        return;
    throw new DOMException(signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'Aborted'), 'AbortError');
}
async function cancelReader(reader, reason) {
    try {
        await reader.cancel(reason);
    }
    catch { /* preserve primary failure */ }
    try {
        reader.releaseLock();
    }
    catch { /* already released */ }
}
/**
 * Exact reads over a byte stream, served from a block read ahead of them: a
 * stream read is an await through the stream machinery (and, across RPC, its
 * pump), so the small reads a record's header and metadata take come out of
 * one READ_AHEAD_BYTES block instead of one read each. A read larger than
 * the block (a chunk's data) fills its own buffer directly.
 */
class ExactByteReader {
    reader;
    signal;
    done = false;
    block = new Uint8Array(0);
    offset = 0;
    constructor(reader, signal) {
        this.reader = reader;
        this.signal = signal;
    }
    async read(read, cancel) {
        throwIfAborted(this.signal);
        const abort = () => { void cancel().catch(() => { }); };
        this.signal?.addEventListener('abort', abort, { once: true });
        try {
            const result = await read();
            throwIfAborted(this.signal);
            return result;
        }
        finally {
            this.signal?.removeEventListener('abort', abort);
        }
    }
    /** One stream read into `view`; zero bytes at the end of the stream. */
    async fill(view) {
        const next = await this.read(() => this.reader.read(view), () => this.reader.cancel(this.signal?.reason));
        if (next.done) {
            this.done = true;
            return new Uint8Array(0);
        }
        return next.value;
    }
    async readExact(length, label) {
        if (length === 0)
            return new Uint8Array(0);
        const buffered = this.block.byteLength - this.offset;
        if (buffered >= length) {
            const out = this.block.slice(this.offset, this.offset + length);
            this.offset += length;
            return out;
        }
        const output = new Uint8Array(length);
        let filled = 0;
        if (buffered > 0) {
            output.set(this.block.subarray(this.offset), 0);
            filled = buffered;
        }
        this.offset = this.block.byteLength;
        while (filled < length) {
            if (this.done) {
                throw new Error(`w7-frame: stream ended ${filled} bytes into expected ${length}-byte ${label}`);
            }
            const remaining = length - filled;
            if (remaining >= READ_AHEAD_BYTES) {
                const got = await this.fill(output.subarray(filled));
                filled += got.byteLength;
                // The read took output's buffer and handed it back under a new view.
                if (got.byteLength > 0)
                    return this.finish(got, length);
                continue;
            }
            // A BYOB read transfers the buffer it fills and returns it: the block's
            // storage is reused from read to read, never reallocated.
            const got = await this.fill(new Uint8Array(this.spare(), 0, READ_AHEAD_BYTES));
            const take = Math.min(remaining, got.byteLength);
            output.set(got.subarray(0, take), filled);
            filled += take;
            this.block = got;
            this.offset = take;
        }
        return output;
    }
    /** The read-ahead storage, taken back from the block once it is drained. */
    spare() {
        const storage = this.block.buffer;
        return storage.byteLength >= READ_AHEAD_BYTES ? storage : new ArrayBuffer(READ_AHEAD_BYTES);
    }
    /**
     * A large read lands in place: what one read returned is a view over the
     * output's own (transferred) buffer, so the remainder fills the same one.
     */
    async finish(view, length) {
        let filled = view.byteOffset + view.byteLength;
        let buffer = view.buffer;
        while (filled < length) {
            if (this.done) {
                throw new Error(`w7-frame: stream ended ${filled} bytes into expected ${length}-byte file-chunk data`);
            }
            const got = await this.fill(new Uint8Array(buffer, filled, length - filled));
            buffer = got.buffer;
            filled += got.byteLength;
        }
        return new Uint8Array(buffer, 0, length);
    }
    async ensureEof(stream) {
        if (this.offset < this.block.byteLength) {
            await this.reader.cancel(new Error('w7-frame: trailing bytes after batch-end'));
            throw new Error('w7-frame: trailing bytes after batch-end');
        }
        if (this.done)
            return;
        this.reader.releaseLock();
        const reader = stream.getReader();
        try {
            const next = await this.read(() => reader.read(), () => reader.cancel(this.signal?.reason));
            if (!next.done && next.value.byteLength > 0) {
                await reader.cancel(new Error('w7-frame: trailing bytes after batch-end'));
                throw new Error('w7-frame: trailing bytes after batch-end');
            }
            this.done = true;
        }
        finally {
            try {
                reader.releaseLock();
            }
            catch { /* already released */ }
        }
    }
}
