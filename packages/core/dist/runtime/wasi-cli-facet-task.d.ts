/** A plain WASI command's guest entry (wasi-cli-runner.ts), compiled without importing its host/bootstrap graph. */
import type { FacetBindings } from './facet-host.js';
import type { VfsCred } from './os-contracts.js';
export interface WasiCliFacetArgs {
    argv: string[];
    env: Record<string, string>;
    /** The directory the program starts in (nimbus_proc.startup_dir). */
    cwd: string;
    cred: VfsCred;
    /** The session pid the program runs as: its output and input, and the parent of the children it starts. */
    pid: number;
}
/** What a run ends with; its output went to the session as it was written. */
export interface WasiCliFacetResult {
    exitCode: number;
    error?: string;
    /** Whether another run may use this facet (__wasiReusable: no syscall in it was abandoned). */
    reusable?: boolean;
}
/** What the preamble's __wasiCliRun is handed: the call's arguments, the compiled image and the facet's capability. */
export interface WasiCliRunArgs extends WasiCliFacetArgs {
    program: WebAssembly.Module;
    supervisor: FacetBindings['SUPERVISOR'];
}
declare global {
    /** Installed by the wasi-cli-runner preamble (WASI_CLI_RUNNER_PREAMBLE). */
    var __wasiCliRun: ((args: WasiCliRunArgs) => Promise<WasiCliFacetResult>) | undefined;
}
/** Runs in the facet: hands the compiled image and the capability to the preamble's __wasiCliRun. */
export declare function wasiCliFacetCall(args: WasiCliFacetArgs, facetEnv: FacetBindings): Promise<WasiCliFacetResult>;
//# sourceMappingURL=wasi-cli-facet-task.d.ts.map