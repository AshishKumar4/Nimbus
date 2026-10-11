/**
 * git/pack/facet-supervisor.ts — the session as the git network facet
 * reaches it: its SUPERVISOR binding's calls, each counted for the facet's
 * report, and the session's file API under a phase's deadline.
 */
import { MAX_RPC_SAFE_PAYLOAD_BYTES } from '@nimbus-sh/platform/limits.js';
import { useRpcResource } from '@nimbus-sh/platform/rpc-dispose.js';
import type { WaveSupervisor } from '@nimbus-sh/platform/wave-writer.js';
import { normalizeVfsPath } from '@nimbus-sh/core/vfs/path.js';
import type { SupervisorRPC } from '../../session/supervisor-rpc.js';
import type { GitFsStat } from '../git-fs.js';
import type { FacetPacksSupervisor } from './facet-packs.js';
import { withinDeadline, type FileApi, type FileStat } from './mount-writer.js';

/** An inode as the supervisor reports it (its stat and lstat). */
export interface SupervisorStat {
  type?: string;
  size?: number;
  mode?: number;
  mtime?: number;
  ctime?: number;
  atime?: number;
  uid?: number;
  gid?: number;
  dev?: number;
  ino?: number;
}

/** The SUPERVISOR binding's calls the facet makes: the session's own (session/supervisor-calls.ts). */
export type GitFacetSupervisor = Pick<SupervisorRPC,
  | 'stat' | 'lstat' | 'readdir' | 'readFileBytes' | 'fsReadRange' | 'fsReadRangeUncached' | 'readlink'
  | 'fsWriteRange' | 'fsTruncate' | 'rename' | 'unlink' | 'mkdir' | 'fsOpen' | 'fsWrite' | 'fsFstat' | 'fsClose' | 'chmod'
  | 'hasLegacySymlinkUnder' | 'stdout' | 'writeBatchStream' | 'openWaveWriter'>;

/** A file larger than this comes back by ranges: an RPC value's structured-clone ceiling. */
export const WHOLE_FILE_RPC_SAFE_BYTES = MAX_RPC_SAFE_PAYLOAD_BYTES;
export const READ_RANGE_BYTES = 4 * 1024 * 1024;
export const METADATA_MAX_ENTRIES = 100_000;
export const METADATA_MAX_ACCOUNTED_BYTES = 32 * 1024 * 1024;

/** The supervisor calls an invocation made, by kind: what it reports, and network-facet.ts totals. */
export interface SupervisorRpcCounters {
  stat: number;
  lstat: number;
  readdir: number;
  readFile: number;
  fsReadRange: number;
  /** Pack appends (and a thin pack's count rewrite): one per <=448 KiB piece. */
  fsWriteRange: number;
  rename: number;
  /** A commit-graph chain's lock: its create, write, close, chmod and removal. */
  lock: number;
  writeBatchStream: number;
  readlink: number;
  symlink: number;
  legacySymlinkSubtree: number;
  stdout: number;
  /** On a mount, a file past a wave's limit (pack/mount-writer.ts): its open, each write, its stat and close. */
  fileApi: number;
}

export function createSupervisorRpcCounters(): SupervisorRpcCounters {
  return {
    stat: 0, lstat: 0, readdir: 0, readFile: 0,
    fsReadRange: 0, fsWriteRange: 0, rename: 0, lock: 0, writeBatchStream: 0, readlink: 0, symlink: 0,
    legacySymlinkSubtree: 0, stdout: 0, fileApi: 0,
  };
}

/** What an invocation reports of its work. */
export interface FacetStats {
  filesWritten: number;
  bytesWritten: number;
  supervisorRpc: SupervisorRpcCounters;
}

export interface MetadataOverlayStats {
  entries: number;
  accountedBytes: number;
  maxEntries: number;
  maxAccountedBytes: number;
}

export function emptyMetadataOverlayStats(): MetadataOverlayStats {
  return { entries: 0, accountedBytes: 0, maxEntries: METADATA_MAX_ENTRIES, maxAccountedBytes: METADATA_MAX_ACCOUNTED_BYTES };
}

/** `call`'s result, counted under `name`, its RPC resource disposed. */
export function counted<T>(stats: FacetStats, name: keyof SupervisorRpcCounters, call: () => Promise<T>): Promise<T> {
  stats.supervisorRpc[name]++;
  return useRpcResource(call(), (result) => result);
}

/** A supervisor stat, its missing fields as the session's own git reads them. */
export function supervisorStat(st: SupervisorStat): GitFsStat {
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
export async function supervisorNames(supervisor: GitFacetSupervisor, stats: FacetStats, path: string): Promise<string[]> {
  stats.supervisorRpc.readdir++;
  try {
    const entries = await useRpcResource(supervisor.readdir(normalizeVfsPath(path)), (result) => result);
    return entries.map((entry) => typeof entry === 'string' ? entry : entry.name);
  } catch {
    return [];
  }
}

/** The supervisor's ranged calls, counted, as git/pack/facet-packs.ts takes them. */
export function facetPacksSupervisor(supervisor: GitFacetSupervisor, stats: FacetStats, ensureDirectory: (dir: string) => Promise<void>): FacetPacksSupervisor {
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
export function facetFileApi(supervisor: GitFacetSupervisor, stats: FacetStats, deadline: number | null = null): FileApi {
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
