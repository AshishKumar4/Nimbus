/**
 * W7 v3 — incremental typed records for streamed bulk filesystem writes.
 * The format is internal: every producer and consumer deploys together.
 */
import { CHUNK_SIZE } from '../constants.js';
export const W7_MAGIC = new Uint8Array([0x4e, 0x57, 0x37, 0x03]);
const ENCODER_QUEUE_HWM = 0;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 64 * 1024;
const MAX_BATCH_ID_BYTES = 128;
const MAX_CONTENT_ID_BYTES = 256;
export const W7_MAX_PATHS_PER_BATCH = 128;
export const W7_MAX_OWNED_PATH_BYTES = 64 * 1024;
export const W7_MAX_RECORD_BYTES = 5 + 4 + MAX_CONTENT_ID_BYTES + 8 + CHUNK_SIZE;
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
/** Encode one bounded record per pull; no batch-sized metadata header exists. */
export function encodeWriteBatchStream(payload) {
    const batchId = crypto.randomUUID();
    const { deletes, directories, files } = preparePayload(payload, batchId);
    const iterator = encodeRecords(batchId, deletes, directories, files);
    let closed = false;
    let magicEmitted = false;
    const source = {
        type: 'bytes',
        pull(controller) {
            if (closed)
                return;
            try {
                if (!magicEmitted) {
                    magicEmitted = true;
                    controller.enqueue(W7_MAGIC.slice());
                    return;
                }
                const next = iterator.next();
                if (next.done) {
                    closed = true;
                    controller.close();
                    return;
                }
                for (const part of next.value)
                    controller.enqueue(part);
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
    const buffer = new ExactByteReader(reader);
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
        const initialCheck = updateRecordCheck(CRC_SEED, beginEnvelope.header, beginPayload);
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
                const prefixLength = Math.min(envelope.length, 4 + MAX_CONTENT_ID_BYTES + 8);
                const idLengthBytes = await buffer.readExact(4, 'file-chunk content-id length');
                const idLength = readU32LE(idLengthBytes, 0);
                if (idLength === 0 || idLength > MAX_CONTENT_ID_BYTES) {
                    throw new Error(`w7-frame: invalid file-chunk content-id length ${idLength}`);
                }
                const remainingPrefixLength = idLength + 8;
                if (4 + remainingPrefixLength > prefixLength || 4 + remainingPrefixLength > envelope.length) {
                    throw new Error('w7-frame: malformed file-chunk record length');
                }
                const rest = await buffer.readExact(remainingPrefixLength, 'file-chunk header');
                const contentId = decodeText(rest.subarray(0, idLength), 'file-chunk content id');
                const chunkId = readU32LE(rest, idLength);
                const dataLength = readU32LE(rest, idLength + 4);
                if (envelope.length !== 4 + idLength + 8 + dataLength) {
                    throw new Error('w7-frame: file-chunk payload length mismatch');
                }
                if (contentId !== active.metadata.contentId) {
                    throw new Error(`w7-frame: file-chunk content id ${contentId} does not own ${active.inode.path}`);
                }
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
                const headerPayload = concatBytes(idLengthBytes, rest);
                let retention = null;
                try {
                    retention = options.retainChunk
                        ? await options.retainChunk(dataLength, options.signal)
                        : noopRetention(dataLength);
                    throwIfAborted(options.signal);
                    const data = await buffer.readExact(dataLength, 'file-chunk data');
                    batchCheck = updateRecordCheck(batchCheck, envelope.header, headerPayload, data);
                    active.check = crc32Update(active.check, data);
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
                        inode,
                        nextChunkId: 0,
                        receivedBytes: 0,
                        check: CRC_SEED,
                    };
                    yield { type: 'file-begin', streamContentId: metadata.contentId, inode };
                    break;
                }
                case RecordTag.FileEnd: {
                    if (!active)
                        throw new Error('w7-frame: file-end without active file');
                    const metadata = parseFileEnd(payload);
                    const actualCheck = crc32Finish(active.check);
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
                    const expected = { ...summary, check: crc32Finish(batchCheck) };
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
function* encodeRecords(batchId, deletes, directories, files) {
    const state = {
        batchCheck: CRC_SEED,
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
        let fileCheck = CRC_SEED;
        for (const chunk of file.chunks) {
            const data = chunk.data;
            const contentBytes = new TextEncoder().encode(file.contentId);
            const prefix = new Uint8Array(4 + contentBytes.length + 8);
            writeU32LE(prefix, 0, contentBytes.length);
            prefix.set(contentBytes, 4);
            writeU32LE(prefix, 4 + contentBytes.length, chunk.chunkId);
            writeU32LE(prefix, 8 + contentBytes.length, data.byteLength);
            const header = recordHeader(RecordTag.FileChunk, prefix.byteLength + data.byteLength);
            state.batchCheck = updateRecordCheck(state.batchCheck, header, prefix, data);
            state.summary.recordCount++;
            state.summary.chunkCount++;
            state.summary.byteCount += data.byteLength;
            fileCheck = crc32Update(fileCheck, data);
            yield [concatBytes(header, prefix), data];
        }
        yield encodeMetadataRecord(RecordTag.FileEnd, {
            contentId: file.contentId,
            size: file.inode.size,
            chunkCount: file.inode.chunkCount,
            check: crc32Finish(fileCheck),
        }, state);
    }
    const end = {
        ...state.summary,
        check: crc32Finish(state.batchCheck),
    };
    yield encodeMetadataRecord(RecordTag.BatchEnd, end);
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
        if (normalizedInode.kind === 'directory') {
            if (fileChunks.length > 0)
                throw new Error(`w7-frame: directory ${path} has chunks`);
            directories.push(normalizedInode);
        }
        else {
            validateChunks(normalizedInode, fileChunks);
            files.push({
                inode: normalizedInode,
                contentId: `${batchId}:${fileIndex++}`,
                chunks: fileChunks,
            });
        }
        chunksByPath.delete(path);
    }
    if (chunksByPath.size > 0) {
        throw new Error(`w7-frame: chunk has no inode: ${chunksByPath.keys().next().value}`);
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
    const expected = size === 0 ? 0 : Math.ceil(size / CHUNK_SIZE);
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
        const expected = inode.size === 0 ? 0 : Math.ceil(inode.size / CHUNK_SIZE);
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
        const nextPathBytes = this.pathBytes + new TextEncoder().encode(path).byteLength;
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
    const length = new TextEncoder().encode(value).byteLength;
    if (length > maxBytes)
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
        check = crc32Update(check, part);
    return check;
}
const CRC_SEED = 0xffff_ffff;
let crcTable = null;
function crc32Update(check, bytes) {
    const table = crcTable ??= createCrcTable();
    let value = check;
    for (const byte of bytes)
        value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
    return value >>> 0;
}
function crc32Finish(check) {
    return (check ^ 0xffff_ffff) >>> 0;
}
function createCrcTable() {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) {
            value = (value & 1) !== 0 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
        }
        table[index] = value >>> 0;
    }
    return table;
}
function noopRetention(bytes) {
    return { bytes, release() { } };
}
function decodeText(bytes, label) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch (error) {
        throw new Error(`w7-frame: invalid UTF-8 in ${label}: ${errorMessage(error)}`);
    }
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
class ExactByteReader {
    reader;
    done = false;
    constructor(reader) {
        this.reader = reader;
    }
    async readExact(length, label) {
        if (length === 0)
            return new Uint8Array(0);
        const output = new Uint8Array(length);
        let offset = 0;
        while (offset < length) {
            if (this.done) {
                throw new Error(`w7-frame: stream ended ${offset} bytes into expected ${length}-byte ${label}`);
            }
            const next = await this.reader.read(new Uint8Array(length - offset));
            if (next.done)
                this.done = true;
            else if (next.value.byteLength > 0) {
                output.set(next.value, offset);
                offset += next.value.byteLength;
            }
        }
        return output;
    }
    async ensureEof(stream) {
        if (this.done)
            return;
        this.reader.releaseLock();
        const reader = stream.getReader();
        try {
            const next = await reader.read();
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
