/**
 * git/pack/buffered-fs.ts — the git network facet's filesystem: cf-git's
 * writes buffered as records for the wave writer (@nimbus-sh/platform
 * wave-writer.ts), which publishes them in W7 waves, one in flight while the
 * next buffers; its reads answered from the buffer, or from the supervisor.
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
import type { GitFsBackend } from '../git-fs.js';
import { type FacetStats, type GitFacetSupervisor } from './facet-supervisor.js';
export interface BufferedFs {
    backend: GitFsBackend;
    flushWave(): Promise<void>;
    waveStats(): WaveStats;
}
export declare function createBufferedFs(supervisor: GitFacetSupervisor, stats: FacetStats, phaseDeadline?: number | null, worktreeRoot?: string | null, onMount?: boolean): BufferedFs;
//# sourceMappingURL=buffered-fs.d.ts.map