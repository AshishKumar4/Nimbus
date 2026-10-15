/** The real Git guest entry, compiled without importing its host/bootstrap graph. */
import type { FacetBindings } from './facet-host.js';
import type { VfsCred } from './os-contracts.js';
import type { ResidentFilesystemStats } from './wasi/resident-filesystem.js';
export interface GitFacetArgs {
    argv: string[];
    env: Record<string, string>;
    cred: VfsCred;
    /** The session pid git runs as (its runtime process): its output and input, and the parent of the children it starts. */
    pid: number;
    /** The image asks again a wait its host gave up on (GIT_RUNNER_CONTRACTS). */
    restartsWaits: boolean;
}
/** What a git run ends with; its output went to the session as it was written (SupervisorRPC stdout/stderr). */
export interface GitFacetResult {
    exitCode: number;
    error?: string;
    /** git's filesystem calls and who answered them (wasi/resident-filesystem.ts). */
    fsStats?: ResidentFilesystemStats | null;
    /** Whether another git may run in this facet (__wasiReusable: no syscall in it was abandoned). */
    reusable?: boolean;
    /** The facet's clock (which moves only across I/O) where the run entered, git was instantiated, and git exited. */
    clock?: {
        entered: number;
        instantiated: number;
        exited: number;
    };
}
/** Runs in the facet: hands the compiled image and the capability to the preamble's __gitRun. */
export declare function gitFacetCall(args: GitFacetArgs, facetEnv: FacetBindings): Promise<GitFacetResult>;
//# sourceMappingURL=git-facet-task.d.ts.map