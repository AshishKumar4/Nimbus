import type { FdEntry, WasiInitOptions, WasiInstanceBundle, WasiMakeImportsOptions, WasiRunResult, WasiStartInstance, WasiSupervisorStub } from '@nimbus-sh/core/runtime/wasi/types.js';
import { type ResidentFilesystemStats } from '@nimbus-sh/core/runtime/wasi/resident-filesystem.js';
/**
 * The facet's own SQLite, where it has one (a named one-shot, whose storage
 * outlives the run): the process's store lives there, and the next process
 * of the same name and credential starts from what this one read, its pages
 * included. Its growth is the session's storage ledger's to admit (`grant`,
 * N18). Absent, the store is the run's heap.
 */
interface WasiStorage {
    sql: unknown;
    grant?: {
        facet: string;
        grant: number;
    };
}
/** Adopt the facet's SQLite for the next process's store (before its first filesystem call). */
export declare function __wasiAdoptStorage(storage: WasiStorage | null): void;
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
export {};
//# sourceMappingURL=preamble.d.ts.map