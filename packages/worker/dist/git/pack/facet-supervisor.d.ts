import type { SupervisorRPC } from '../../session/supervisor-rpc.js';
import type { GitFsStat } from '../git-fs.js';
import type { FacetPacksSupervisor } from './facet-packs.js';
import { type FileApi } from './mount-writer.js';
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
export type GitFacetSupervisor = Pick<SupervisorRPC, 'stat' | 'lstat' | 'readdir' | 'readFileBytes' | 'fsReadRange' | 'fsReadRangeUncached' | 'readlink' | 'fsWriteRange' | 'fsTruncate' | 'rename' | 'unlink' | 'mkdir' | 'fsOpen' | 'fsWrite' | 'fsFstat' | 'fsClose' | 'chmod' | 'hasLegacySymlinkUnder' | 'stdout' | 'writeBatchStream' | 'openWaveWriter'>;
/** A file larger than this comes back by ranges: an RPC value's structured-clone ceiling. */
export declare const WHOLE_FILE_RPC_SAFE_BYTES: number;
export declare const READ_RANGE_BYTES: number;
export declare const METADATA_MAX_ENTRIES = 100000;
export declare const METADATA_MAX_ACCOUNTED_BYTES: number;
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
export declare function createSupervisorRpcCounters(): SupervisorRpcCounters;
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
export declare function emptyMetadataOverlayStats(): MetadataOverlayStats;
/** `call`'s result, counted under `name`, its RPC resource disposed. */
export declare function counted<T>(stats: FacetStats, name: keyof SupervisorRpcCounters, call: () => Promise<T>): Promise<T>;
/** A supervisor stat, its missing fields as the session's own git reads them. */
export declare function supervisorStat(st: SupervisorStat): GitFsStat;
/** Names from a supervisor readdir, [] when it fails (an absent directory). */
export declare function supervisorNames(supervisor: GitFacetSupervisor, stats: FacetStats, path: string): Promise<string[]>;
/** The supervisor's ranged calls, counted, as git/pack/facet-packs.ts takes them. */
export declare function facetPacksSupervisor(supervisor: GitFacetSupervisor, stats: FacetStats, ensureDirectory: (dir: string) => Promise<void>): FacetPacksSupervisor;
/**
 * The session's file API through the facet's binding (pack/mount-writer.ts
 * FileApi), its lease presented by the binding, each call counted; within
 * the phase's deadline as withinDeadline admits calls (a close or an
 * unlink, cleaning up, past it too).
 */
export declare function facetFileApi(supervisor: GitFacetSupervisor, stats: FacetStats, deadline?: number | null): FileApi;
//# sourceMappingURL=facet-supervisor.d.ts.map