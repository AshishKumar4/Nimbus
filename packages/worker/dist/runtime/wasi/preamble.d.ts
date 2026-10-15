import type { FdEntry, WasiInitOptions, WasiInstanceBundle, WasiMakeImportsOptions, WasiRunResult, WasiStartInstance, WasiSupervisorStub } from '@nimbus-sh/core/runtime/wasi/types.js';
import { type ResidentFilesystemStats } from '@nimbus-sh/core/runtime/wasi/resident-filesystem.js';
/** Whether another process may run in this facet after this one (FacetSpec.warm): no syscall here was abandoned. */
export declare function __wasiReusable(): boolean;
/**
 * Make what a runtime knows it reads at launch resident before its guest
 * asks: each of `roots` listed whole (a tree past the listing's bound is left
 * to its lookups), and the files of each `reads` directory named with its
 * extension fetched (ResidentFilesystem.prefetch).
 */
export declare function __wasiPrepareFilesystem(roots: readonly string[], reads?: readonly {
    dir: string;
    ext: string;
}[]): Promise<void>;
/** This process's filesystem calls so far and who answered them (ResidentFilesystemStats), or null when the session answered them all. */
export declare function __wasiFsStats(): ResidentFilesystemStats | null;
/**
 * Send what the process holds to the session, at the end of a run: null, or
 * what to report, naming each file whose bytes did not all arrive. A run that
 * reports one did not do what it said it did, and exits non-zero.
 */
export declare function __wasiSettleWrites(): Promise<string | null>;
export declare function __wasiAdoptSupervisor(sup: WasiSupervisorStub | null): void;
export declare function __wasiInitFS(opts: WasiInitOptions): void;
export declare const fdTable: Map<number, FdEntry>;
export declare function __wasiMakeImports(opts: WasiMakeImportsOptions): WasiInstanceBundle;
export declare function __wasiRunStart(instance: WasiStartInstance, ctx?: unknown): WasiRunResult;
export declare function __wasiRunStartAsync(instance: WasiStartInstance, ctx?: unknown): Promise<WasiRunResult>;
//# sourceMappingURL=preamble.d.ts.map