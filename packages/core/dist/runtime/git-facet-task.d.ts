/** The real Git guest entry, compiled without importing its host/bootstrap graph. */
import type { FacetBindings } from './facet-host.js';
import type { WasiCred } from './wasi/types.js';
import type { ResidentFilesystemStats } from './wasi/resident-filesystem.js';
export interface GitFacetArgs {
    argv: string[];
    env: Record<string, string>;
    cred: WasiCred;
    /** The session pid git runs as: the parent of the children it starts. */
    pid: number;
    /** Its output goes to the session as it is written (SupervisorRPC stdout/stderr), not back in the result. */
    live: boolean;
}
export interface GitFacetResult {
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    error?: string;
    /** git's filesystem calls and who answered them (wasi/resident-filesystem.ts). */
    fsStats?: ResidentFilesystemStats | null;
}
/** Runs in the facet: hands the compiled image and the capability to the preamble's __gitRun. */
export declare function gitFacetCall(args: GitFacetArgs, facetEnv: FacetBindings): Promise<GitFacetResult>;
//# sourceMappingURL=git-facet-task.d.ts.map