/**
 * The W7 wave's contracts: what a wave's caller asks (WriteStreamOptions)
 * and is answered (WriteBatchStreamResult), the namespace that places its
 * records (WaveRouter), and the storage seam the session's filesystem opens
 * for each wave (WaveScope), through which WaveIngest commits what lands
 * there. Shared by the ingestion, the engine, the runtime bridges and the
 * clients that send waves.
 */
import { CHUNK_SIZE } from '@nimbus-sh/platform/limits.js';
import { w7ChunkCount, } from '@nimbus-sh/platform/w7-frame.js';
import { parentKey } from '../vfs/path.js';
import { vfsError } from '../vfs/vfs-error.js';
/**
 * A wave's consecutive calls that commit together, in one transaction (the
 * stream's call group): at most this many, or this many bytes of their
 * data. Measured in process: a writeFile call alone cost 177 us, most of it
 * its own commit (2026-10-07, apply-prof); a group pays that once.
 */
export const CALL_GROUP_OPS = 512;
export const CALL_GROUP_BYTES = 1024 * 1024;
/** The longest target a routed symbolic link takes, in bytes: PATH_MAX, as symlink(2) bounds it. */
export const ROUTED_LINK_TARGET_MAX = 4096;
/**
 * The largest file a wave writes to a mount. A routed file is one
 * whole-file writeFile, its bytes held until that call under credit its
 * record reserves whole when it is admitted (so an admitted record always
 * finishes; at most the shared write credit, MAX_GLOBAL_WRITE_STREAM_CREDIT_BYTES,
 * and half of it, so a held file never starves the wave); a larger one is
 * refused (ENOTSUP, naming this) before anything is touched. A backend that
 * declares an atomic streaming write could take more; none does yet.
 */
export const ROUTED_FILE_MAX = 4 * 1024 * 1024;
/**
 * The most bytes one data call (W7DataCall: a writeFile, appendFile or
 * write at an offset) carries. Its bytes are held until the call is made,
 * under credit its record reserves whole when it begins, as a routed
 * file's are; a client splits a larger write into pieces of this size
 * (process-fs-client's DATA_PIECE_BYTES, WAVE_BYTES). A larger call is
 * refused (EINVAL) before any of its bytes are read.
 */
export const DATA_CALL_MAX = 4 * 1024 * 1024;
/** `cred` with the umask a process's call was made under, when the call carries one (W7Call umask). */
export function withUmask(cred, umask) {
    return umask === undefined || umask === cred.umask ? cred : { ...cred, umask };
}
/**
 * Abort a stream commit when ANY of the given signals fires. AbortSignal.any
 * is not in every runtime this code ships to, so the combination is a small
 * linked controller instead.
 */
export function linkedSignal(signals) {
    const controller = new AbortController();
    const listeners = [];
    for (const signal of signals) {
        if (!signal)
            continue;
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        const onAbort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        listeners.push(() => signal.removeEventListener('abort', onAbort));
    }
    return { signal: controller.signal, dispose: () => { for (const remove of listeners)
            remove(); } };
}
/**
 * `work`, something a wave waits for, raced with the wave's `signal`: once
 * it aborts, the wave goes on at once (ending refused), and a late answer is
 * `discard`ed. The namespace's guard starts no backend call after the abort
 * (WaveRouter.apply).
 */
export function untilAborted(work, signal, discard) {
    if (signal === undefined)
        return work;
    return new Promise((resolve, reject) => {
        const abort = () => { work.then((late) => discard?.(late), () => { }); reject(signal.reason); };
        if (signal.aborted)
            return abort();
        signal.addEventListener('abort', abort, { once: true });
        work.then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
    });
}
export function inodeKind(inode) {
    const kind = inode.kind ?? (inode.isDir ? 'directory' : 'file');
    if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink') {
        throw vfsError('EINVAL', `invalid inode kind ${String(kind)}`);
    }
    return kind;
}
export function validateFileChunks(inode, chunks) {
    validateInodeShape(inode);
    if (inode.chunkCount !== chunks.length) {
        throw vfsError('EINVAL', inode.path, `expected ${inode.chunkCount} chunks, got ${chunks.length}`);
    }
    let total = 0;
    const ordered = [...chunks].sort((a, b) => a.chunkId - b.chunkId);
    for (let index = 0; index < ordered.length; index++) {
        const chunk = ordered[index];
        if (chunk.chunkId !== index) {
            throw vfsError('EINVAL', inode.path, `expected chunk ${index}, got ${chunk.chunkId}`);
        }
        const expected = Math.min(CHUNK_SIZE, inode.size - (index * CHUNK_SIZE));
        if (chunk.data.byteLength !== expected) {
            throw vfsError('EINVAL', inode.path, `chunk ${index} has ${chunk.data.byteLength} bytes; expected ${expected}`);
        }
        total += chunk.data.byteLength;
    }
    if (total !== inode.size) {
        throw vfsError('EINVAL', inode.path, `chunk bytes ${total} do not match size ${inode.size}`);
    }
}
export function validateInodeShape(inode) {
    const kind = inodeKind(inode);
    const expectedParent = parentKey(inode.path);
    if (inode.parentPath !== expectedParent) {
        throw vfsError('EINVAL', inode.path, `parentPath ${inode.parentPath} does not match ${expectedParent}`);
    }
    if (inode.isDir !== (kind === 'directory')) {
        throw vfsError('EINVAL', inode.path, `inode kind ${kind} conflicts with isDir=${inode.isDir}`);
    }
    if (!Number.isSafeInteger(inode.size) || inode.size < 0) {
        throw vfsError('EINVAL', inode.path, `invalid size ${inode.size}`);
    }
    if (!Number.isSafeInteger(inode.chunkCount) || inode.chunkCount < 0) {
        throw vfsError('EINVAL', inode.path, `invalid chunk count ${inode.chunkCount}`);
    }
    if (kind === 'directory' && inode.size !== 0) {
        throw vfsError('EINVAL', inode.path, 'directory size must be zero');
    }
    const expectedChunkCount = kind === 'directory' ? 0 : w7ChunkCount(inode.size);
    if (inode.chunkCount !== expectedChunkCount) {
        throw vfsError('EINVAL', `${inode.path}: expected ${expectedChunkCount} chunks for ${inode.size} bytes, got ${inode.chunkCount}`);
    }
}
