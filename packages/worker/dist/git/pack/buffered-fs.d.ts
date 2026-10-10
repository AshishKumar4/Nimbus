/**
 * git/pack/buffered-fs.ts — the git network facet's filesystem: cf-git's
 * writes buffered as records for the wave writer (@nimbus-sh/platform
 * wave-writer.ts), which publishes them in W7 waves, one in flight while the
 * next buffers; its reads answered from the buffer, from the closed-world
 * metadata overlay a clone reads back, or from the supervisor.
 *
 * With a worktreeRoot (fetch, pull, push in an existing repository) the
 * writer writes that worktree the way git's checkout does (entry.c
 * create_directories, has_symlink_leading_path): below its top, .git aside,
 * a leading component that is not a real directory (a link, dangling or
 * not, or a file) is deleted and replaced by a directory rather than
 * followed, and a file replaces a link at its own path rather than writing
 * through it.
 */
import { type WaveStats } from '@nimbus-sh/platform/wave-writer.js';
import { type GitFsBackend } from '../git-fs.js';
import { type FacetStats, type GitFacetSupervisor, type MetadataOverlayStats, type SupervisorStat } from './facet-supervisor.js';
/** A path the overlay knows, as the wave that publishes it will. */
export interface OverlayEntry {
    kind: 'dir' | 'file' | 'symlink';
    size: number;
    mode: number;
    mtimeMs: number;
    ctimeMs: number;
    atimeMs: number;
    target?: string;
}
/** A supervisor stat as an overlay entry. */
export declare function overlayEntryOf(st: SupervisorStat): OverlayEntry;
export interface BufferedFs {
    backend: GitFsBackend;
    flushWave(): Promise<void>;
    overlayStats(): MetadataOverlayStats;
    /**
     * `alreadyDurable` records that these exact bytes are known to be durably
     * published at path (the caller read them back), so waves can assert the
     * pin's presence without ever re-writing unchanged content.
     */
    pinFile(path: string, data: string, alreadyDurable?: boolean): void;
    unpinFile(path: string): void;
    waveStats(): WaveStats;
}
export declare function createBufferedFs(supervisor: GitFacetSupervisor, stats: FacetStats, authoritativeRoot: string | null, authoritativeRootMetadata: OverlayEntry | null, phaseDeadline?: number | null, worktreeRoot?: string | null, onMount?: boolean): BufferedFs;
//# sourceMappingURL=buffered-fs.d.ts.map