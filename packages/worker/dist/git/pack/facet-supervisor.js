/**
 * git/pack/facet-supervisor.ts — the session as the git network facet
 * reaches it: its SUPERVISOR binding's calls, each counted for the facet's
 * report, and the session's file API under a phase's deadline.
 */
import { MAX_RPC_SAFE_PAYLOAD_BYTES } from '@nimbus-sh/platform/limits.js';
import { useRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import { withinDeadline } from './mount-writer.js';
/** A file larger than this comes back by ranges: an RPC value's structured-clone ceiling. */
export const WHOLE_FILE_RPC_SAFE_BYTES = MAX_RPC_SAFE_PAYLOAD_BYTES;
export const READ_RANGE_BYTES = 4 * 1024 * 1024;
export const METADATA_MAX_ENTRIES = 100_000;
export const METADATA_MAX_ACCOUNTED_BYTES = 32 * 1024 * 1024;
export function createSupervisorRpcCounters() {
    return {
        stat: 0, lstat: 0, readdir: 0, readFile: 0,
        fsReadRange: 0, fsWriteRange: 0, rename: 0, lock: 0, writeBatchStream: 0, readlink: 0, symlink: 0,
        legacySymlinkSubtree: 0, stdout: 0, fileApi: 0,
    };
}
export function emptyMetadataOverlayStats() {
    return { entries: 0, accountedBytes: 0, maxEntries: METADATA_MAX_ENTRIES, maxAccountedBytes: METADATA_MAX_ACCOUNTED_BYTES };
}
/** `call`'s result, counted under `name`, its RPC resource disposed. */
export function counted(stats, name, call) {
    stats.supervisorRpc[name]++;
    return useRpcResource(call(), (result) => result);
}
/** A supervisor stat, its missing fields as the session's own git reads them. */
export function supervisorStat(st) {
    const mtimeMs = Number(st.mtime) || Date.now();
    const type = st.type === 'directory' || st.type === 'dir' ? 'dir' : st.type === 'symlink' ? 'symlink' : 'file';
    return {
        type,
        size: Number(st.size) || 0,
        mode: (Number(st.mode) || (type === 'dir' ? 0o755 : type === 'symlink' ? 0o777 : 0o644)) & 0o7777,
        mtimeMs,
        ctimeMs: Number(st.ctime) || mtimeMs,
        atimeMs: Number(st.atime) || mtimeMs,
        // The supervisor's git reports these same fields, so an index either side wrote stays warm.
        uid: Number(st.uid) || 0,
        gid: Number(st.gid) || 0,
        dev: Number(st.dev) || 0,
        ino: Number(st.ino) || 0,
        nlink: 1,
    };
}
/** Names from a supervisor readdir, [] when it fails (an absent directory). */
export async function supervisorNames(supervisor, stats, path) {
    stats.supervisorRpc.readdir++;
    try {
        const entries = await useRpcResource(supervisor.readdir(normalizeVfsPath(path)), (result) => result);
        return entries.map((entry) => typeof entry === 'string' ? entry : entry.name);
    }
    catch {
        return [];
    }
}
/** The supervisor's ranged calls, counted, as git/pack/facet-packs.ts takes them. */
export function facetPacksSupervisor(supervisor, stats, ensureDirectory) {
    // Paths reach the supervisor as this facet's fs sends them: normalized.
    return {
        // Pack bytes bypass the session's content cache: a cached range pins its
        // chunks in the session's heap (512 x 64 KiB), which the clone shares.
        fsReadRange: (path, offset, length) => counted(stats, 'fsReadRange', () => supervisor.fsReadRangeUncached(normalizeVfsPath(path), offset, length)),
        fsWriteRange: (path, offset, bytes) => counted(stats, 'fsWriteRange', () => supervisor.fsWriteRange(normalizeVfsPath(path), offset, bytes)),
        fsTruncate: (path, size) => counted(stats, 'fsWriteRange', () => supervisor.fsTruncate(normalizeVfsPath(path), size)),
        rename: (from, to) => counted(stats, 'rename', () => supervisor.rename(normalizeVfsPath(from), normalizeVfsPath(to))),
        unlink: (path) => counted(stats, 'rename', () => supervisor.unlink(normalizeVfsPath(path))),
        ensureDirectory,
        readdir: (path) => supervisorNames(supervisor, stats, path),
    };
}
/**
 * The session's file API through the facet's binding (pack/mount-writer.ts
 * FileApi), its lease presented by the binding, each call counted; within
 * the phase's deadline as withinDeadline admits calls (a close or an
 * unlink, cleaning up, past it too).
 */
export function facetFileApi(supervisor, stats, deadline = null) {
    return withinDeadline({
        mkdir: (path, options) => counted(stats, 'fileApi', () => supervisor.mkdir(path, options)),
        unlink: (path) => counted(stats, 'fileApi', () => supervisor.unlink(path)),
        discard: (path) => counted(stats, 'fileApi', () => supervisor.unlink(path)),
        fsOpen: (path, flags) => counted(stats, 'fileApi', () => supervisor.fsOpen(path, flags)),
        fsWrite: (id, offset, bytes) => counted(stats, 'fileApi', () => supervisor.fsWrite(id, offset, bytes)),
        fsFstat: (id) => counted(stats, 'fileApi', () => supervisor.fsFstat(id)),
        fsClose: (id) => counted(stats, 'fileApi', () => supervisor.fsClose(id)),
        rename: (from, to) => counted(stats, 'rename', () => supervisor.rename(from, to)),
    }, deadline);
}
